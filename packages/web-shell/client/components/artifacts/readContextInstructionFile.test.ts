// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { DaemonCapabilities, DaemonClient } from '@qwen-code/sdk/daemon';
import { readContextInstructionFile } from './readContextInstructionFile';

const capabilities = {
  workspaceCwd: '/a',
  workspaces: [
    { id: 'a', cwd: '/a', primary: true, trusted: true },
    { id: 'b', cwd: '/b', primary: false, trusted: true },
  ],
} as unknown as DaemonCapabilities;

interface ClientOptions {
  workspaceTruncated?: boolean;
  memoryFiles?: Array<{ path: string; content?: string; truncated?: boolean }>;
}

function makeClient(options: ClientOptions = {}) {
  const primaryRead = vi.fn(async (path: string) => ({
    content: `primary:${path}`,
    truncated: options.workspaceTruncated ?? false,
  }));
  const secondaryRead = vi.fn(async (path: string) => ({
    content: `secondary:${path}`,
    truncated: options.workspaceTruncated ?? false,
  }));
  const memory = vi.fn(async () => ({
    files: options.memoryFiles ?? [
      { path: '/home/u/.qwen/QWEN.md', content: 'global content' },
    ],
  }));
  const byCwd = vi.fn(() => ({ readWorkspaceFile: secondaryRead }));
  const client = {
    readWorkspaceFile: primaryRead,
    workspaceMemory: memory,
    workspaceByCwd: byCwd,
  } as unknown as DaemonClient;
  return { client, primaryRead, secondaryRead, memory, byCwd };
}

describe('readContextInstructionFile', () => {
  it('reads a secondary workspace file through its own route, never the primary', async () => {
    const { client, primaryRead, secondaryRead, byCwd, memory } = makeClient();
    const result = await readContextInstructionFile(
      client,
      capabilities,
      '/b',
      '/b/AGENTS.md',
    );
    expect(result.content).toBe('secondary:/b/AGENTS.md');
    expect(result.truncated).toBe(false);
    expect(byCwd).toHaveBeenCalledWith('/b');
    expect(secondaryRead).toHaveBeenCalledWith('/b/AGENTS.md', {
      maxBytes: 256 * 1024,
    });
    expect(primaryRead).not.toHaveBeenCalled();
    expect(memory).not.toHaveBeenCalled();
  });

  it('reads a nested secondary workspace file through the same qualified route', async () => {
    const { client, primaryRead, secondaryRead } = makeClient();
    const result = await readContextInstructionFile(
      client,
      capabilities,
      '/b',
      '/b/packages/foo/AGENTS.md',
    );
    expect(result.content).toBe('secondary:/b/packages/foo/AGENTS.md');
    expect(primaryRead).not.toHaveBeenCalled();
    expect(secondaryRead).toHaveBeenCalledOnce();
  });

  it('reads a primary workspace file through the primary route', async () => {
    const { client, primaryRead, byCwd } = makeClient();
    const result = await readContextInstructionFile(
      client,
      capabilities,
      '/a',
      '/a/AGENTS.md',
    );
    expect(result.content).toBe('primary:/a/AGENTS.md');
    expect(primaryRead).toHaveBeenCalledOnce();
    expect(byCwd).not.toHaveBeenCalled();
  });

  it('reads a global memory file through the memory route', async () => {
    const { client, primaryRead, secondaryRead, memory } = makeClient();
    const result = await readContextInstructionFile(
      client,
      capabilities,
      '/a',
      '/home/u/.qwen/QWEN.md',
    );
    expect(result.content).toBe('global content');
    expect(result.truncated).toBe(false);
    expect(memory).toHaveBeenCalledWith({ includeContent: true });
    expect(primaryRead).not.toHaveBeenCalled();
    expect(secondaryRead).not.toHaveBeenCalled();
  });

  it('rejects a file whose workspace is not a registered owner', async () => {
    const { client, primaryRead, secondaryRead, memory } = makeClient();
    await expect(
      readContextInstructionFile(client, capabilities, '/c', '/c/AGENTS.md'),
    ).rejects.toThrow('workspace');
    expect(primaryRead).not.toHaveBeenCalled();
    expect(secondaryRead).not.toHaveBeenCalled();
    expect(memory).not.toHaveBeenCalled();
  });

  it('fails when a global path is not a loaded memory file', async () => {
    const { client } = makeClient();
    await expect(
      readContextInstructionFile(
        client,
        capabilities,
        '/a',
        '/home/u/.qwen/other.md',
      ),
    ).rejects.toThrow('No readable memory file');
  });

  it('opens a worktree instruction file through the registered admission root', async () => {
    const repoCapabilities = {
      workspaceCwd: '/repo',
      workspaces: [{ id: 'repo', cwd: '/repo', primary: true, trusted: true }],
    } as unknown as DaemonCapabilities;
    const worktreeFile = '/repo/.qwen/worktrees/task/AGENTS.md';
    const { client, primaryRead, byCwd } = makeClient();

    const result = await readContextInstructionFile(
      client,
      repoCapabilities,
      '/repo',
      worktreeFile,
    );
    expect(result.content).toBe(`primary:${worktreeFile}`);
    expect(primaryRead).toHaveBeenCalledWith(worktreeFile, {
      maxBytes: 256 * 1024,
    });
    expect(byCwd).not.toHaveBeenCalled();

    await expect(
      readContextInstructionFile(
        client,
        repoCapabilities,
        '/repo/.qwen/worktrees/task',
        worktreeFile,
      ),
    ).rejects.toThrow('workspace');
  });

  it('reads a file under a filesystem-root workspace through the file route', async () => {
    // owner.cwd '/' must not double the separator and miss every file.
    const rootCapabilities = {
      workspaceCwd: '/',
      workspaces: [{ id: 'root', cwd: '/', primary: true, trusted: true }],
    } as unknown as DaemonCapabilities;
    const { client, primaryRead, memory } = makeClient();
    const result = await readContextInstructionFile(
      client,
      rootCapabilities,
      '/',
      '/x/AGENTS.md',
    );
    expect(result.content).toBe('primary:/x/AGENTS.md');
    expect(primaryRead).toHaveBeenCalledWith('/x/AGENTS.md', {
      maxBytes: 256 * 1024,
    });
    expect(memory).not.toHaveBeenCalled();
  });

  it('surfaces truncation from the workspace file route', async () => {
    const { client } = makeClient({ workspaceTruncated: true });
    const result = await readContextInstructionFile(
      client,
      capabilities,
      '/a',
      '/a/AGENTS.md',
    );
    expect(result.content).toBe('primary:/a/AGENTS.md');
    expect(result.truncated).toBe(true);
  });

  it('surfaces truncation from the memory route', async () => {
    const { client } = makeClient({
      memoryFiles: [
        { path: '/home/u/.qwen/QWEN.md', content: 'global', truncated: true },
      ],
    });
    const result = await readContextInstructionFile(
      client,
      capabilities,
      '/a',
      '/home/u/.qwen/QWEN.md',
    );
    expect(result.content).toBe('global');
    expect(result.truncated).toBe(true);
  });

  it('distinguishes a listed memory file whose text is withheld from a missing one', async () => {
    // The route keeps the entry but omits content for non-UTF-8 bytes.
    const { client } = makeClient({
      memoryFiles: [{ path: '/home/u/.qwen/QWEN.md' }],
    });
    await expect(
      readContextInstructionFile(
        client,
        capabilities,
        '/a',
        '/home/u/.qwen/QWEN.md',
      ),
    ).rejects.toThrow('could not be read as UTF-8');
  });
});
