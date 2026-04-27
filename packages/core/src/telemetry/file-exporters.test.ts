/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSpanExporter } from './file-exporters.js';

type SerializeAccess = { serialize: (data: unknown) => string };

describe('FileExporter.serialize', () => {
  let tmpDir: string;
  let exporter: FileSpanExporter;
  let serialize: (data: unknown) => string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-exporters-test-'));
    exporter = new FileSpanExporter(path.join(tmpDir, 'out.jsonl'));
    serialize = (exporter as unknown as SerializeAccess).serialize.bind(
      exporter,
    );
  });

  afterEach(async () => {
    await exporter.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Regression for upstream PR #4689: a raw JSON.stringify on a ReadableSpan
  // crashed because BatchSpanProcessor._shutdownOnce -> BindOnceFuture._that
  // forms a cycle. The exporter must delegate to safeJsonStringify so cycles
  // become "[Circular]" instead of throwing.
  it('does not throw on BatchSpanProcessor-shaped cycle', () => {
    const proc: Record<string, unknown> = { kind: 'BatchSpanProcessor' };
    const future: Record<string, unknown> = { kind: 'BindOnceFuture' };
    proc['_shutdownOnce'] = future;
    future['_that'] = proc;
    const span = { name: 'span-1', _spanProcessor: proc };

    expect(() => serialize(span)).not.toThrow();
    const out = serialize(span);
    expect(out).toContain('"name": "span-1"');
    expect(out).toContain('"[Circular]"');
    expect(out.endsWith('\n')).toBe(true);
  });
});
