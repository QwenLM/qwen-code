/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { createDelegatedReader } from './delegated-reader.js';
import { MediaReadError, type MediaReadContext } from '../reader-registry.js';
import type { MediaProbe } from '../types.js';

const probe: MediaProbe = {
  path: '/tmp/a.mp4',
  hash: 'abc',
  modality: 'video',
  mimeType: 'video/mp4',
  sizeBytes: 10,
};

const ctx = { signal: new AbortController().signal } as MediaReadContext;

describe('delegated reader', () => {
  it('runs a command backend and wraps stdout as a note', async () => {
    const reader = createDelegatedReader({
      id: 'echoer',
      via: 'command',
      ref: 'echo hello-{path}',
    });
    const result = await reader.read(probe, {}, ctx);
    const text = (result.content as Array<{ text?: string }>)[0].text ?? '';
    expect(text).toContain('hello-/tmp/a.mp4');
    expect(text).toContain('reader="echoer"');
    expect(result.precision).toContain('derived note');
  });

  it('fails closed with a remedy for unwired dispatch kinds', async () => {
    const reader = createDelegatedReader({
      id: 'ocr',
      via: 'subagent',
      ref: 'media-ocr',
    });
    await expect(reader.read(probe, {}, ctx)).rejects.toBeInstanceOf(
      MediaReadError,
    );
  });

  it('fails closed when the command is missing', async () => {
    const reader = createDelegatedReader({
      id: 'nope',
      via: 'command',
      ref: 'this-binary-does-not-exist-xyz {path}',
    });
    await expect(reader.read(probe, {}, ctx)).rejects.toBeInstanceOf(
      MediaReadError,
    );
  });
});
