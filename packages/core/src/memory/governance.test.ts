/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reviewManagedAutoMemoryGovernance } from './governance.js';
import { getAutoMemoryTopicPath } from './paths.js';
import { ensureAutoMemoryScaffold } from './store.js';

describe('managed auto-memory governance review', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-memory-governance-'));
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

  it('produces heuristic governance suggestions', async () => {
    await fs.writeFile(
      getAutoMemoryTopicPath(projectRoot, 'project'),
      [
        '---',
        'type: project',
        'title: Project Memory',
        'description: Project facts',
        '---',
        '',
        '# Project Memory',
        '',
        '- Dashboard: https://grafana.example/d/api',
        '- Dashboard: https://grafana.example/d/api',
        '- This is only temporary for this task.',
      ].join('\n'),
      'utf-8',
    );

    const review = await reviewManagedAutoMemoryGovernance(projectRoot);

    expect(review.strategy).toBe('heuristic');
    expect(review.suggestions.some((item) => item.type === 'duplicate')).toBe(true);
    expect(review.suggestions.some((item) => item.type === 'migrate')).toBe(true);
    expect(review.suggestions.some((item) => item.type === 'forget')).toBe(true);
  });
});