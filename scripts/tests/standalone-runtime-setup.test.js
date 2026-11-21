/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchVerifiedArchive,
  sweepRuntimeCache,
} from '../lib/runtime-archive-cache.js';
import { BUN_VERSION, NODE_VERSION } from '../lib/standalone-runtime-pins.js';

const runtimeScript = path.resolve(
  import.meta.dirname,
  '../test-standalone-runtimes.mjs',
);
const source = fs.readFileSync(runtimeScript, 'utf8');
const runSource = source.slice(
  source.indexOf('const run = '),
  source.indexOf('\n// A setup phase'),
);
const budgetSource = source.slice(
  source.indexOf('const makeSetupBudget = '),
  source.indexOf('\nasync function worker('),
);
const ciSource = source.slice(
  source.indexOf('async function ci()'),
  source.indexOf("\nif (process.argv[2] === '--ci')"),
);
const payloads = {
  node: Buffer.from('verified Node archive fixture'),
  bun: Buffer.from('verified Bun archive fixture'),
};
const filenames = {
  node: `node-v${NODE_VERSION}-linux-x64.tar.gz`,
  bun: `bun-linux-x64-${BUN_VERSION}.tgz`,
};
const pins = {
  node: createHash('sha256').update(payloads.node).digest('hex'),
  bun: 'sha512-' + createHash('sha512').update(payloads.bun).digest('base64'),
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('standalone runtime CI setup', () => {
  let root;
  let cacheDir;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-setup-test-'));
    cacheDir = path.join(root, 'cache');
    fs.mkdirSync(cacheDir);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const events = [];
    const pending = new Map();
    const verified = { node: deferred(), bun: deferred() };
    let finishing = false;
    const response = (runtime) => new Response(payloads[runtime]);
    const fetch = vi.fn((url) => {
      const runtime = url.includes('nodejs.org') ? 'node' : 'bun';
      if (finishing) return Promise.resolve(response(runtime));
      const request = deferred();
      pending.set(runtime, request);
      return request.promise;
    });
    const spawnSync = vi.fn((bin, args) => {
      events.push(
        bin === 'tar' ? `extract:${path.basename(args[1])}` : 'worker',
      );
      return { status: 0, signal: null, stdout: '', stderr: '' };
    });
    const sweep = vi.fn((...args) => {
      events.push('sweep');
      return sweepRuntimeCache(...args);
    });
    // Run the real ci(), setup deadline and command wrapper. Only the external
    // download responses, runtime pins and native subprocess boundary are fixtures.
    const execute = runInNewContext(
      `${runSource}\n${budgetSource}\n${ciSource}\nci`,
      {
        assert,
        fs,
        path,
        createHash,
        URL,
        AbortSignal,
        DOMException,
        setTimeout,
        Date,
        console,
        NODE_VERSION,
        BUN_VERSION,
        os: { tmpdir: () => root },
        process: {
          platform: 'linux',
          arch: 'x64',
          env: { QWEN_STANDALONE_RUNTIME_CACHE: cacheDir },
        },
        script: runtimeScript,
        SETUP_TIMEOUT_MS: 60_000,
        CI_TIMEOUT_MS: 1_140_000,
        RUNTIME_ARCHIVE_DIGESTS: { 'linux-x64': pins },
        fetch,
        spawnSync,
        sweepRuntimeCache: sweep,
        fetchVerifiedArchive: async (url, filename, pin, options) => {
          const bytes = await fetchVerifiedArchive(url, filename, pin, options);
          const runtime = filename.startsWith('node-') ? 'node' : 'bun';
          events.push(`verified:${runtime}`);
          verified[runtime].resolve();
          return bytes;
        },
      },
    );
    return {
      execute,
      fetch,
      spawnSync,
      sweep,
      events,
      verified,
      release(runtime) {
        pending.get(runtime).resolve(response(runtime));
      },
      finish() {
        finishing = true;
        for (const [runtime, request] of pending)
          request.resolve(response(runtime));
      },
    };
  }

  it('starts both downloads before waiting and verifies both before extraction or sweeping', async () => {
    const f = fixture();
    const outcome = f.execute();
    try {
      expect(f.fetch).toHaveBeenCalledTimes(2);
      f.release('bun');
      await f.verified.bun.promise;
      expect(f.spawnSync).not.toHaveBeenCalled();
      expect(f.sweep).not.toHaveBeenCalled();
      f.release('node');
      await outcome;
      expect(f.events).toEqual([
        'verified:bun',
        'verified:node',
        'extract:node.tgz',
        'extract:bun.tgz',
        'sweep',
        'worker',
      ]);
      expect(f.sweep).toHaveBeenCalledWith(cacheDir, [
        filenames.node,
        filenames.bun,
      ]);
      for (const runtime of ['node', 'bun']) {
        expect(
          fs.readFileSync(path.join(cacheDir, filenames[runtime])),
        ).toEqual(payloads[runtime]);
      }
    } finally {
      f.finish();
      await outcome;
    }
  });

  it('verifies warm cache entries without fetching and sweeps only after both are ready', async () => {
    for (const runtime of ['node', 'bun']) {
      fs.writeFileSync(
        path.join(cacheDir, filenames[runtime]),
        payloads[runtime],
      );
    }
    const obsolete = path.join(cacheDir, 'obsolete.tgz');
    fs.writeFileSync(obsolete, 'unused');
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(obsolete, old, old);
    const f = fixture();
    await f.execute();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.events).toEqual([
      'verified:node',
      'verified:bun',
      'extract:node.tgz',
      'extract:bun.tgz',
      'sweep',
      'worker',
    ]);
    expect(fs.existsSync(obsolete)).toBe(false);
    expect(fs.readdirSync(cacheDir).sort()).toEqual(
      Object.values(filenames).sort(),
    );
  });
});
