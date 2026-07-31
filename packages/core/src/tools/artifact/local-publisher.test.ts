/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalPublisher } from './local-publisher.js';

describe('LocalPublisher', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-artifact-'));
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('writes index.html and returns a file:// url', async () => {
    const pub = new LocalPublisher(baseDir);
    const res = await pub.publish({
      id: 'abc123',
      title: 'T',
      html: '<!doctype html><p>hi</p>',
    });

    expect(res.id).toBe('abc123');
    expect(res.url.startsWith('file://')).toBe(true);
    expect(res.filePath).toBe(path.join(baseDir, 'abc123', 'index.html'));

    const written = await fs.readFile(fileURLToPath(res.url), 'utf8');
    expect(written).toContain('<p>hi</p>');
  });

  it('redeploys the same id to the same url (overwrite in place)', async () => {
    const pub = new LocalPublisher(baseDir);
    const first = await pub.publish({
      id: 'same',
      title: 'T',
      html: '<p>v1</p>',
    });
    const second = await pub.publish({
      id: 'same',
      title: 'T',
      html: '<p>v2</p>',
    });

    expect(second.url).toBe(first.url);
    const written = await fs.readFile(fileURLToPath(second.url), 'utf8');
    expect(written).toContain('<p>v2</p>');
    expect(written).not.toContain('<p>v1</p>');
  });

  it('isolates different ids into different directories', async () => {
    const pub = new LocalPublisher(baseDir);
    const a = await pub.publish({ id: 'a', title: 'A', html: '<p>a</p>' });
    const b = await pub.publish({ id: 'b', title: 'B', html: '<p>b</p>' });
    expect(a.url).not.toBe(b.url);
  });
});
