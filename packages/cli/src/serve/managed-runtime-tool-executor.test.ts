/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ManagedToolExecutor } from './managed-runtime-tool-executor.js';

const roots = new Set<string>();
afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-mtr-executor-'));
  roots.add(root);
  fs.writeFileSync(path.join(root, 'a.txt'), 'contents');
  return root;
}

const reference = {
  sessionId: 'session-a',
  promptId: 'prompt-1',
  callId: 'call-1',
  argsDigest: createHash('sha256').update('args').digest('hex'),
};

describe('ManagedToolExecutor acknowledgement', () => {
  it('lets a session close after its settled call is acknowledged', async () => {
    const executor = ManagedToolExecutor.forWorkspace(
      workspace(),
      'runtime-01',
    );
    const result = await executor.execute(reference, 'read_file', {
      file_path: 'a.txt',
    });
    expect(result.executionStatus).toBe('success');

    expect(executor.acknowledge(reference)?.state).toBe('acknowledged');
    // The acknowledged entry no longer holds the session's work open.
    expect(executor.hasActiveSession('session-a')).toBe(false);
    expect(() => executor.closeSessionAdmission('session-a')).not.toThrow();
  });

  it('answers unknown for a reference the Runtime never saw', () => {
    const executor = ManagedToolExecutor.forWorkspace(
      workspace(),
      'runtime-01',
    );
    expect(executor.acknowledge(reference)).toBeNull();
    expect(executor.status(reference)).toBeNull();
  });
});
