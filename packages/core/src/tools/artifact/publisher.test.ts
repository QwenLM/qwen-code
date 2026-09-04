/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { artifactIdFromPath } from './publisher.js';

describe('artifactIdFromPath', () => {
  it('is stable for the same path', () => {
    const a = artifactIdFromPath('/tmp/project/report.html');
    const b = artifactIdFromPath('/tmp/project/report.html');
    expect(a).toBe(b);
  });

  it('normalizes equivalent paths to the same id', () => {
    const a = artifactIdFromPath('/tmp/project/report.html');
    const b = artifactIdFromPath('/tmp/project/./sub/../report.html');
    expect(a).toBe(b);
  });

  it('differs for different paths', () => {
    expect(artifactIdFromPath('/tmp/a.html')).not.toBe(
      artifactIdFromPath('/tmp/b.html'),
    );
  });

  it('resolves relative paths against cwd deterministically', () => {
    const rel = artifactIdFromPath('report.html');
    const abs = artifactIdFromPath(path.resolve('report.html'));
    expect(rel).toBe(abs);
  });

  it('is a short hex string', () => {
    expect(artifactIdFromPath('/tmp/a.html')).toMatch(/^[0-9a-f]{16}$/);
  });
});
