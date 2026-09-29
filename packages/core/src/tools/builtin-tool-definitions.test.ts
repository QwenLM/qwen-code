/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  getEditToolDefinition,
  getGlobToolDefinition,
  getLSToolDefinition,
  getReadFileToolDefinition,
  getShellToolDefinition,
  getWriteFileToolDefinition,
  projectEditToolClassifierInput,
  projectReadFileToolClassifierInput,
  projectShellToolClassifierInput,
  projectWriteFileToolClassifierInput,
} from './builtin-tool-definitions.js';
import { managedToolDigest } from './managed-tool-protocol.js';
import { RuntimeBackedTool } from './runtime-backed-tool.js';
import { ToolNames } from './tool-names.js';

vi.mock('./read-file.js', () => {
  throw new Error('Offline declarations must not load ReadFile');
});
vi.mock('./write-file.js', () => {
  throw new Error('Offline declarations must not load WriteFile');
});
vi.mock('./edit.js', () => {
  throw new Error('Offline declarations must not load Edit');
});
vi.mock('./shell.js', () => {
  throw new Error('Offline declarations must not load Shell');
});
vi.mock('../utils/pdf.js', () => {
  throw new Error('Offline declarations must not load PDF execution');
});
vi.mock('../utils/shell-utils.js', () => {
  throw new Error('Offline declarations must not discover a shell');
});

describe('offline builtin tool definitions', () => {
  it('creates declarations and proxies without acquiring a Runtime client', () => {
    const getClient = vi.fn(() => {
      throw new Error('Runtime is still booting');
    });
    const definitions = [
      getReadFileToolDefinition(),
      getWriteFileToolDefinition(),
      getEditToolDefinition(),
      getShellToolDefinition({
        shellConfiguration: {
          executable: 'bash',
          argsPrefix: ['-c'],
          shell: 'bash',
        },
        platform: 'linux',
      }),
      getGlobToolDefinition(),
      getLSToolDefinition(),
    ];
    const tools = definitions.map(
      (descriptor) =>
        new RuntimeBackedTool({
          descriptor,
          sessionId: 'b8a456ee-8d8e-4c4a-adbd-9bacb4eb0ad7',
          getClient,
          projectClassifierInput: projectReadFileToolClassifierInput,
        }),
    );

    expect(tools.map((tool) => tool.schema.name)).toEqual([
      ToolNames.READ_FILE,
      ToolNames.WRITE_FILE,
      ToolNames.EDIT,
      ToolNames.SHELL,
      ToolNames.GLOB,
      ToolNames.LS,
    ]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      tool.build({});
    }
    expect(managedToolDigest(definitions)).toMatch(/^[a-f0-9]{64}$/);
    expect(getClient).not.toHaveBeenCalled();
    expect(tools[0].maxOutputChars).toBe(Infinity);
    expect(tools[3].maxOutputChars).toBe(30_000);
  });

  it('returns independent schemas for different sessions', () => {
    const first = getReadFileToolDefinition();
    const digest = managedToolDigest(first);
    first.schema.parametersJsonSchema = {};
    expect(managedToolDigest(getReadFileToolDefinition())).toBe(digest);
  });

  it('uses the explicit shell profile without reading the ambient environment', () => {
    const definition = getShellToolDefinition({
      shellConfiguration: {
        executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        argsPrefix: ['-NoProfile', '-Command'],
        shell: 'powershell',
      },
      platform: 'win32',
      outputThreshold: 45_000,
    });
    expect(definition.description).toContain(
      '`pwsh.exe -NoProfile -Command <command>`',
    );
    expect(definition.description).not.toContain(
      'Command process group can be terminated',
    );
    expect(definition.maxOutputChars).toBe(45_000);
    expect(definition.canUpdateOutput).toBe(true);
    expect(definition.isOutputMarkdown).toBe(false);
  });

  it('projects only the existing AUTO fields and uses the current child cwd', () => {
    const input: Record<string, unknown> = {
      file_path: '/workspace/file',
      content: '你'.repeat(301),
      old_string: 'old\n',
      new_string: 'new\nline\n',
      command: 'printf "$SECRET"',
      unrelatedSecret: 'must not reach classifier',
    };
    expect(projectReadFileToolClassifierInput()).toBe('');
    expect(projectWriteFileToolClassifierInput(input)).toEqual({
      file_path: '/workspace/file',
      byte_count: 903,
      content_preview: '你'.repeat(300),
      content_truncated: true,
    });
    expect(projectEditToolClassifierInput(input)).toEqual({
      file_path: '/workspace/file',
      old_string_preview: 'old\n',
      new_string_preview: 'new\nline\n',
      old_string_truncated: false,
      new_string_truncated: false,
      lines_changed: 1,
    });
    expect(projectShellToolClassifierInput(input, '/child')).toEqual({
      command: 'printf "$SECRET"',
      cwd: '/child',
    });
    expect(
      projectShellToolClassifierInput(
        { ...input, directory: '/child/subdir' },
        '/child',
      ),
    ).toEqual({ command: 'printf "$SECRET"', cwd: '/child/subdir' });
  });
});
