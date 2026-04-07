/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAutoMemoryFilePath } from './paths.js';
import {
  parseAutoMemoryTopicDocument,
  scanAutoMemoryTopicDocuments,
} from './scan.js';
import { ensureAutoMemoryScaffold } from './store.js';

describe('auto-memory topic scanning', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-memory-scan-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    await ensureAutoMemoryScaffold(projectRoot);
  });

  afterEach(async () => {
    await fs.rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  });

  it('parses a managed auto-memory topic document', () => {
    const parsed = parseAutoMemoryTopicDocument(
      '/tmp/project.md',
      [
        '---',
        'type: project',
        'title: Project Memory',
        'description: Project context',
        '---',
        '',
        '# Project Memory',
        '',
        '- Release freeze starts Friday.',
      ].join('\n'),
    );

    expect(parsed).toEqual({
      type: 'project',
      filePath: '/tmp/project.md',
      relativePath: 'project.md',
      filename: 'project.md',
      title: 'Project Memory',
      description: 'Project context',
      body: '# Project Memory\n\n- Release freeze starts Friday.',
      mtimeMs: 0,
    });
  });

  it('scans existing auto-memory files from nested topic folders', async () => {
    const referencePath = getAutoMemoryFilePath(
      projectRoot,
      path.join('reference', 'grafana.md'),
    );
    await fs.mkdir(path.dirname(referencePath), { recursive: true });
    await fs.writeFile(
      referencePath,
      [
        '---',
        'type: reference',
        'name: Reference Memory',
        'description: External references',
        '---',
        '',
        'Oncall dashboard: grafana.internal/d/api-latency',
      ].join('\n'),
      'utf-8',
    );

    const docs = await scanAutoMemoryTopicDocuments(projectRoot);
    const referenceDoc = docs.find((doc) => doc.type === 'reference');

    expect(referenceDoc?.description).toBe('External references');
    expect(referenceDoc?.relativePath).toBe(path.join('reference', 'grafana.md'));
    expect(referenceDoc?.body).toContain('grafana.internal/d/api-latency');
  });
});