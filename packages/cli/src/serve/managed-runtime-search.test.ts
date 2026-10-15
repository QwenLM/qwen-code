/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import { unregisterSessionProjectDir } from '@qwen-code/qwen-code-core/utils/sessionIdContext.js';
import {
  createManagedToolSet,
  ManagedToolExecutor,
  type ManagedToolResultPayload,
} from './managed-runtime-tool-executor.js';

describe('Managed Runtime search', () => {
  let root: string;
  const sessionId = 'search-session';
  beforeEach(async () => {
    root = await realpath(
      await mkdtemp(path.join(tmpdir(), 'managed-search-')),
    );
    vi.stubEnv('QWEN_RUNTIME_DIR', path.join(root, 'runtime'));
    await mkdir(path.join(root, 'src'));
    await writeFile(
      path.join(root, 'src', 'a.ts'),
      `Needle ${root}\nsecond line\n`,
    );
    await writeFile(path.join(root, 'src', 'b.txt'), 'needle in text\n');
  });
  afterEach(async () => {
    unregisterSessionProjectDir(sessionId);
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  function reference(input: Record<string, unknown>) {
    return {
      sessionId,
      promptId: 'prompt-search',
      callId: randomUUID(),
      argsDigest: `sha256:${managedToolDigest(input)}`,
    };
  }
  function output(result: ManagedToolResultPayload): string {
    return JSON.stringify(result.responseParts);
  }

  it('executes file search without rewriting matched content or escaping paths', async () => {
    const executor = ManagedToolExecutor.forWorkspace(root, sessionId);
    const input = { pattern: 'needle', path: 'src', glob: '*.ts' };
    const result = await executor.execute(
      reference(input),
      'grep_search',
      input,
    );
    expect(result.executionStatus).toBe('success');
    expect(output(result)).toContain('src/a.ts');
    expect(output(result)).toContain(`Needle ${root}`);
    expect(output(result)).not.toContain('b.txt');
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      48 * 1024,
    );
  });

  it('lists a directory without inspecting a symlink target', async () => {
    await symlink('/no/such/target', path.join(root, 'src', 'link'));
    const executor = ManagedToolExecutor.forWorkspace(root, sessionId);
    const input = { path: 'src' };
    const ref = reference(input);
    const result = await executor.execute(ref, 'list_directory', input);
    expect(result.executionStatus).toBe('success');
    expect(output(result)).toContain('a.ts');
    expect(output(result)).toContain('link');
    expect(output(result)).not.toContain(root);
    expect(output(result)).not.toContain('/no/such/target');
    executor.acknowledge(ref);
    expect(() => executor.closeSessionAdmission(sessionId)).not.toThrow();
  });

  it.each(['grep_search', 'list_directory'])(
    'keeps missing-path diagnostics relative for %s',
    async (tool) => {
      const executor = ManagedToolExecutor.forWorkspace(root, sessionId);
      const input = {
        ...(tool === 'grep_search' ? { pattern: 'needle' } : {}),
        path: 'absent',
      };
      const result = await executor.execute(reference(input), tool, input);
      expect(result.executionStatus).toBe('error');
      expect(JSON.stringify(result)).not.toContain(root);
      expect(JSON.stringify(result)).toContain('absent');
    },
  );

  it.each(['glob', 'grep_search', 'list_directory'])(
    'bounds %s worker failures without changing their status',
    async (toolName) => {
      const tools = createManagedToolSet(root, sessionId);
      vi.spyOn(tools.tools.get(toolName)!, 'build').mockImplementation(() => {
        throw new Error('失败'.repeat(30000));
      });
      const executor = new ManagedToolExecutor(async () => tools);
      const input = toolName === 'list_directory' ? {} : { pattern: 'needle' };
      const result = await executor.execute(reference(input), toolName, input);
      expect(result.executionStatus).toBe('error');
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
        48 * 1024,
      );
      expect(result.error?.message).toContain('Narrow the path or pattern');
    },
  );

  it.each(['grep_search', 'list_directory'])(
    'rejects escaping %s roots',
    async (tool) => {
      const executor = ManagedToolExecutor.forWorkspace(root, sessionId);
      for (const requested of ['../outside', root]) {
        const input = {
          ...(tool === 'grep_search' ? { pattern: 'needle' } : {}),
          path: requested,
        };
        const result = await executor.execute(reference(input), tool, input);
        expect(result.executionStatus).toBe('error');
        expect(output(result)).not.toContain('Needle');
      }
    },
  );

  it.each(['grep_search', 'list_directory'])(
    'checks %s paths belonging to another installed Session',
    async (tool) => {
      const privateDirectory = path.join(root, 'private');
      await mkdir(privateDirectory);
      await writeFile(
        path.join(privateDirectory, 'secret.ts'),
        'needle private contents',
      );
      const tools = createManagedToolSet(root, sessionId);
      const owns = async (_session: string, target: string) =>
        target === privateDirectory ||
        target.startsWith(privateDirectory + path.sep);
      const executor = new ManagedToolExecutor(
        async () => tools,
        undefined,
        undefined,
        undefined,
        owns,
      );
      const input =
        tool === 'grep_search' ? { pattern: 'needle', limit: 1 } : {};
      const result = await executor.execute(reference(input), tool, input);
      expect(result.executionStatus).toBe('error');
      expect(output(result)).not.toContain('private contents');
      expect(result.error?.message).toContain('Session working directory');
    },
  );
});
