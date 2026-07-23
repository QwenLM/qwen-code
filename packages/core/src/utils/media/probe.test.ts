/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { modalityOf, probeMedia, hashFile } from './probe.js';

describe('probe', () => {
  it('maps mime prefixes to modalities', () => {
    expect(modalityOf('image/png')).toBe('image');
    expect(modalityOf('audio/wav')).toBe('audio');
    expect(modalityOf('video/mp4')).toBe('video');
    expect(modalityOf('application/pdf')).toBeUndefined();
  });

  it('probes a media file: identity by content, modality by mime', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'probe-'));
    const file = path.join(dir, 'pic.png');
    await fs.writeFile(file, Buffer.from([1, 2, 3, 4]));

    const probe = await probeMedia(file);
    expect(probe.modality).toBe('image');
    expect(probe.mimeType).toBe('image/png');
    expect(probe.sizeBytes).toBe(4);
    expect(probe.hash).toBe(await hashFile(file));
    expect(probe.path).toBe(path.resolve(file));

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('rejects non-media types', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'probe-'));
    const file = path.join(dir, 'notes.txt');
    await fs.writeFile(file, 'hello');
    await expect(probeMedia(file)).rejects.toThrow('Unsupported media type');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('rejects a missing path', async () => {
    await expect(probeMedia('/nonexistent/nope.png')).rejects.toThrow();
  });
});
