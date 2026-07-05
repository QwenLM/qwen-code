/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExportResultCode } from '@opentelemetry/core';
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
    // Windows occasionally returns ENOTEMPTY when the underlying file
    // handle isn't fully released yet; retry a few times before failing.
    fs.rmSync(tmpDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
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

// Telemetry is best-effort and must never crash the agent. The outfile is often
// a relative path resolved against a cwd that lacks the directory (e.g. an ACP
// session whose process cwd is `/`), which makes createWriteStream emit an
// async `error` event that, if unhandled, takes down the whole process.
describe('FileExporter robustness', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-exporters-robust-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });

  it('creates the parent directory when it does not exist', async () => {
    const nested = path.join(tmpDir, 'a', 'b', 'c');
    const exporter = new FileSpanExporter(path.join(nested, 'out.jsonl'));
    expect(fs.existsSync(nested)).toBe(true);
    await exporter.shutdown();
  });

  it('does not crash when the outfile path is unusable', async () => {
    // Make the parent a regular file so the directory — and therefore the
    // write stream — cannot be created. The async stream `error` must be
    // absorbed rather than crashing the process.
    const blocker = path.join(tmpDir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const badPath = path.join(blocker, 'out.jsonl');

    let exporter: FileSpanExporter | undefined;
    expect(() => {
      exporter = new FileSpanExporter(badPath);
    }).not.toThrow();

    const code = await new Promise<ExportResultCode>((resolve) => {
      exporter!.export([{ name: 'span' } as never], (result) =>
        resolve(result.code),
      );
    });
    expect(code).toBe(ExportResultCode.FAILED);
    await exporter!.shutdown();
  });
});
