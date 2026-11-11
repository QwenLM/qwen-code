import { describe, expect, it } from 'vitest';
import {
  checkEditableInternalPath,
  checkReadableInternalPath,
  isMcpToolOutputPath,
} from './internalPaths.js';

describe('injected internal path context', () => {
  const cwd = '/repo';
  const paths = {
    projectConfigDir: '/repo/.custom',
    userConfigDir: '/home/user/.custom',
    projectStorageDir: '/storage/project',
    plansDir: '/plans',
    inboundUploadDir: '/uploads/session',
    mcpOutputDirName: 'custom-mcp-outputs',
  };

  it('uses injected project paths and retains read-only settings', () => {
    expect(checkEditableInternalPath('/repo/.custom/todo.md', cwd, paths)).toBe(
      true,
    );
    expect(
      checkReadableInternalPath('/repo/.custom/settings.json', cwd, paths),
    ).toBe(true);
    expect(
      checkEditableInternalPath('/repo/.custom/settings.json', cwd, paths),
    ).toBe(false);
    expect(
      checkEditableInternalPath('/repo/.custom/hooks.json', cwd, paths),
    ).toBe(false);
  });

  it('does not grant internal exemptions when path fields are missing', () => {
    expect(checkReadableInternalPath('/repo/.qwen/todo.md', cwd, {})).toBe(
      false,
    );
    expect(checkEditableInternalPath('/repo/.qwen/todo.md', cwd, {})).toBe(
      false,
    );
  });

  it('preserves plan file restrictions and read-only upload paths', () => {
    expect(checkEditableInternalPath('/plans/plan.md', cwd, paths)).toBe(true);
    expect(checkEditableInternalPath('/plans/script.sh', cwd, paths)).toBe(
      false,
    );
    expect(
      checkReadableInternalPath('/uploads/session/file.txt', cwd, paths),
    ).toBe(true);
    expect(
      checkEditableInternalPath('/uploads/session/file.txt', cwd, paths),
    ).toBe(false);
  });

  it('retains case-insensitive MCP fragment matching under arbitrary parents', () => {
    expect(
      isMcpToolOutputPath('/arbitrary/CUSTOM-MCP-OUTPUTS/file.txt', paths),
    ).toBe(true);
    expect(
      isMcpToolOutputPath(
        '/arbitrary/custom-mcp-outputs-other/file.txt',
        paths,
      ),
    ).toBe(false);
  });
});
