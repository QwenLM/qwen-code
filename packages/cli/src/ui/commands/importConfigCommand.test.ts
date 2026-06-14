/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { SettingScope } from '../../config/settings.js';
import {
  formatClaudeMcpImportResult,
  importConfigCommand,
  parseImportConfigArgs,
  resolveImportSourceForScope,
} from './importConfigCommand.js';
import { CommandKind } from './types.js';
import type { ClaudeMcpImportResult } from '../../config/claudeMcpImport.js';

describe('importConfigCommand', () => {
  it('is a built-in command available in all execution modes', () => {
    expect(importConfigCommand.name).toBe('import-config');
    expect(importConfigCommand.kind).toBe(CommandKind.BUILT_IN);
    expect(importConfigCommand.supportedModes).toEqual([
      'interactive',
      'non_interactive',
      'acp',
    ]);
  });

  it('parses default arguments', () => {
    expect(parseImportConfigArgs('')).toEqual({
      source: 'all',
      sourceExplicit: false,
      scope: 'user',
      help: false,
    });
  });

  it('parses source and scope arguments', () => {
    expect(parseImportConfigArgs('claude-code --scope project')).toEqual({
      source: 'claude-code',
      sourceExplicit: true,
      scope: 'project',
      help: false,
    });
    expect(parseImportConfigArgs('--from=desktop -s user')).toEqual({
      source: 'claude-desktop',
      sourceExplicit: true,
      scope: 'user',
      help: false,
    });
  });

  it('reports invalid arguments', () => {
    const result = parseImportConfigArgs('claude-code --scope system');
    expect(result.error).toContain('--scope');
  });

  it('uses project Claude Code configs for default project-scope imports', () => {
    expect(resolveImportSourceForScope('all', 'project', false)).toBe(
      'claude-code',
    );
  });

  it('keeps an explicit all source when importing to project scope', () => {
    expect(resolveImportSourceForScope('all', 'project', true)).toBe('all');
  });

  it('formats imported and skipped servers', () => {
    const message = formatClaudeMcpImportResult({
      scope: 'user',
      settingScope: SettingScope.User,
      scanned: [],
      imported: [
        { name: 'filesystem', source: 'Claude Code' },
        { name: 'github', source: 'Claude Desktop' },
      ],
      skipped: [
        {
          name: 'context7',
          source: 'Claude Code',
          reason: 'already-exists',
        },
      ],
      errors: [],
    } satisfies ClaudeMcpImportResult);

    expect(message.messageType).toBe('warning');
    expect(message.content).toContain('Imported 2 MCP server(s)');
    expect(message.content).toContain('filesystem, github');
    expect(message.content).toContain('Skipped existing server(s): context7');
  });

  it('lists checked paths when nothing was imported', () => {
    const message = formatClaudeMcpImportResult({
      scope: 'user',
      settingScope: SettingScope.User,
      scanned: [
        {
          source: 'claude-code',
          label: 'Claude Code',
          path: '/home/u/.claude.json',
          servers: {},
          errors: [],
          found: false,
        },
      ],
      imported: [],
      skipped: [],
      errors: [],
    } satisfies ClaudeMcpImportResult);

    expect(message.messageType).toBe('info');
    expect(message.content).toContain('No new Claude MCP servers imported');
    expect(message.content).toContain('/home/u/.claude.json');
  });
});
