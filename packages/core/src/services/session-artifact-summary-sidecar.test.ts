/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_PERSISTED_ARTIFACTS } from './session-artifact-persistence.js';
import {
  moveSessionArtifactSummarySidecar,
  readSessionArtifactSummarySidecar,
  readSessionArtifactSummarySidecarAsync,
  removeSessionArtifactSummarySidecar,
  sessionArtifactSummarySidecarPath,
  writeSessionArtifactSummarySidecar,
} from './session-artifact-summary-sidecar.js';

describe('session artifact summary sidecar', () => {
  let directory: string;
  let filePath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-summary-'));
    filePath = sessionArtifactSummarySidecarPath(directory, 'session-1');
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('names the sidecar next to the transcript', () => {
    expect(filePath).toBe(path.join(directory, 'session-1.artifacts.json'));
  });

  it('round-trips a count', () => {
    expect(writeSessionArtifactSummarySidecar(filePath, 3)).toBe(true);
    const sidecar = readSessionArtifactSummarySidecar(filePath);
    expect(sidecar?.version).toBe(1);
    expect(sidecar?.artifactCount).toBe(3);
    expect(typeof sidecar?.updatedAt).toBe('string');
    expect(sidecar?.updatedAt.length).toBeGreaterThan(0);
  });

  it('round-trips a zero count', () => {
    expect(writeSessionArtifactSummarySidecar(filePath, 0)).toBe(true);
    expect(readSessionArtifactSummarySidecar(filePath)?.artifactCount).toBe(0);
  });

  it('returns undefined for a missing sidecar', () => {
    expect(readSessionArtifactSummarySidecar(filePath)).toBeUndefined();
  });

  it.each([
    ['wrong version', { version: 2, artifactCount: 3, updatedAt: 'x' }],
    ['negative count', { version: 1, artifactCount: -1, updatedAt: 'x' }],
    ['fractional count', { version: 1, artifactCount: 1.5, updatedAt: 'x' }],
    ['string count', { version: 1, artifactCount: '3', updatedAt: 'x' }],
    ['count above cap', { version: 1, artifactCount: 501, updatedAt: 'x' }],
    ['missing count', { version: 1, updatedAt: 'x' }],
  ])('rejects %s', (_label, body) => {
    fs.writeFileSync(filePath, JSON.stringify(body));
    expect(readSessionArtifactSummarySidecar(filePath)).toBeUndefined();
  });

  it('rejects malformed JSON', () => {
    fs.writeFileSync(filePath, '{not json');
    expect(readSessionArtifactSummarySidecar(filePath)).toBeUndefined();
  });

  it('accepts the cap boundary count (read and write)', () => {
    // The rejection table pins 501; the acceptance side pins that the
    // boundary is > MAX, not >= MAX (a legal snapshot truncates to exactly
    // MAX_PERSISTED_ARTIFACTS, so this count is reachable).
    expect(
      writeSessionArtifactSummarySidecar(filePath, MAX_PERSISTED_ARTIFACTS),
    ).toBe(true);
    expect(readSessionArtifactSummarySidecar(filePath)?.artifactCount).toBe(
      MAX_PERSISTED_ARTIFACTS,
    );
  });

  it.each([-1, 1.5, Number.NaN, 501])(
    'refuses to write invalid count %p',
    (bad) => {
      expect(writeSessionArtifactSummarySidecar(filePath, bad)).toBe(false);
      expect(fs.existsSync(filePath)).toBe(false);
    },
  );

  it('removes the sidecar and tolerates a missing file', () => {
    writeSessionArtifactSummarySidecar(filePath, 2);
    removeSessionArtifactSummarySidecar(filePath);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(() => removeSessionArtifactSummarySidecar(filePath)).not.toThrow();
  });

  it('moves the sidecar across archive states', () => {
    writeSessionArtifactSummarySidecar(filePath, 4);
    fs.mkdirSync(path.join(directory, 'archive'));
    const destination = path.join(
      directory,
      'archive',
      'session-1.artifacts.json',
    );
    moveSessionArtifactSummarySidecar(filePath, destination);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(readSessionArtifactSummarySidecar(destination)?.artifactCount).toBe(
      4,
    );
  });

  it('treats a missing source as a no-op move', () => {
    const destination = path.join(
      directory,
      'archive',
      'session-1.artifacts.json',
    );
    expect(() =>
      moveSessionArtifactSummarySidecar(filePath, destination),
    ).not.toThrow();
    expect(fs.existsSync(destination)).toBe(false);
  });
});

describe('session artifact summary sidecar — async reader', () => {
  let directory: string;
  let filePath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-summary-'));
    filePath = sessionArtifactSummarySidecarPath(directory, 'session-1');
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('reads a valid sidecar like the sync reader', async () => {
    writeSessionArtifactSummarySidecar(filePath, 3);
    await expect(
      readSessionArtifactSummarySidecarAsync(filePath),
    ).resolves.toEqual(readSessionArtifactSummarySidecar(filePath));
  });

  it('returns undefined for a missing sidecar (ENOENT)', async () => {
    await expect(
      readSessionArtifactSummarySidecarAsync(filePath),
    ).resolves.toBeUndefined();
  });

  it('returns undefined for corrupt JSON', async () => {
    fs.writeFileSync(filePath, '{not json');
    await expect(
      readSessionArtifactSummarySidecarAsync(filePath),
    ).resolves.toBeUndefined();
  });

  it('rethrows non-ENOENT read errors (directory at the path)', async () => {
    fs.mkdirSync(filePath);
    await expect(
      readSessionArtifactSummarySidecarAsync(filePath),
    ).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('rejects with AbortError when the signal is already aborted', async () => {
    writeSessionArtifactSummarySidecar(filePath, 3);
    const controller = new AbortController();
    controller.abort();
    await expect(
      readSessionArtifactSummarySidecarAsync(filePath, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
