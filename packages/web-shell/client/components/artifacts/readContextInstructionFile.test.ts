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

function makeClient() {
  const primaryRead = vi.fn(async (path: string) => ({
    content: `primary:${path}`,
  }));
  const secondaryRead = vi.fn(async (path: string) => ({
    content: `secondary:${path}`,
  }));
  const memory = vi.fn(async () => ({
    files: [{ path: '/home/u/.qwen/QWEN.md', content: 'global content' }],
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
    const content = await readContextInstructionFile(
      client,
      capabilities,
      '/b',
      '/b/AGENTS.md',
    );
    expect(content).toBe('secondary:/b/AGENTS.md');
    expect(byCwd).toHaveBeenCalledWith('/b');
    expect(secondaryRead).toHaveBeenCalledWith('/b/AGENTS.md', {
      maxBytes: 256 * 1024,
    });
    expect(primaryRead).not.toHaveBeenCalled();
    expect(memory).not.toHaveBeenCalled();
  });

  it('reads a nested secondary workspace file through the same qualified route', async () => {
    const { client, primaryRead, secondaryRead } = makeClient();
    const content = await readContextInstructionFile(
      client,
      capabilities,
      '/b',
      '/b/packages/foo/AGENTS.md',
    );
    expect(content).toBe('secondary:/b/packages/foo/AGENTS.md');
    expect(primaryRead).not.toHaveBeenCalled();
    expect(secondaryRead).toHaveBeenCalledOnce();
  });

  it('reads a primary workspace file through the primary route', async () => {
    const { client, primaryRead, byCwd } = makeClient();
    const content = await readContextInstructionFile(
      client,
      capabilities,
      '/a',
      '/a/AGENTS.md',
    );
    expect(content).toBe('primary:/a/AGENTS.md');
    expect(primaryRead).toHaveBeenCalledOnce();
    expect(byCwd).not.toHaveBeenCalled();
  });

  it('reads a global memory file through the memory route', async () => {
    const { client, primaryRead, secondaryRead, memory } = makeClient();
    const content = await readContextInstructionFile(
      client,
      capabilities,
      '/a',
      '/home/u/.qwen/QWEN.md',
    );
    expect(content).toBe('global content');
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
    // Capabilities advertise the registered repository root, not the worktree
    // the session relocated into.
    const repoCapabilities = {
      workspaceCwd: '/repo',
      workspaces: [{ id: 'repo', cwd: '/repo', primary: true, trusted: true }],
    } as unknown as DaemonCapabilities;
    const worktreeFile = '/repo/.qwen/worktrees/task/AGENTS.md';
    const { client, primaryRead, byCwd } = makeClient();

    // The admission root resolves the registered owner and reads the file.
    const content = await readContextInstructionFile(
      client,
      repoCapabilities,
      '/repo',
      worktreeFile,
    );
    expect(content).toBe(`primary:${worktreeFile}`);
    expect(primaryRead).toHaveBeenCalledWith(worktreeFile, {
      maxBytes: 256 * 1024,
    });
    expect(byCwd).not.toHaveBeenCalled();

    // The live worktree cwd is not a registered owner, so it must not be used.
    await expect(
      readContextInstructionFile(
        client,
        repoCapabilities,
        '/repo/.qwen/worktrees/task',
        worktreeFile,
      ),
    ).rejects.toThrow('workspace');
  });
});
