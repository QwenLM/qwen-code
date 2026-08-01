/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  parseExtensionRef,
  buildExtensionRef,
  matchExtensionByRef,
  getExtensionSuggestions,
  buildExtensionContextText,
  EXTENSION_REF_PREFIX,
} from './extension-mention-ref.js';
import { MAX_SUGGESTIONS_TO_SHOW } from '../components/SuggestionsDisplay.js';
import type {
  Config,
  Extension,
  SkillConfig,
  SubagentConfig,
  MCPServerConfig,
} from '@qwen-code/qwen-code-core';

function makeExtension(overrides: Partial<Extension> = {}): Extension {
  return {
    id: 'test-ext',
    name: 'test-ext',
    version: '1.0.0',
    isActive: true,
    path: '/extensions/test-ext',
    config: {
      name: 'test-ext',
      version: '1.0.0',
      description: 'A test extension',
    },
    contextFiles: [],
    ...overrides,
  } as Extension;
}

describe('parseExtensionRef', () => {
  it('returns null for non-ext: input', () => {
    expect(parseExtensionRef('file.txt')).toBeNull();
    expect(parseExtensionRef('server:resource')).toBeNull();
    expect(parseExtensionRef('')).toBeNull();
  });

  it('returns null for bare ext: without name', () => {
    expect(parseExtensionRef('ext:')).toBeNull();
  });

  it('returns name for valid ext: ref', () => {
    expect(parseExtensionRef('ext:browser')).toEqual({ name: 'browser' });
    expect(parseExtensionRef('ext:my-extension')).toEqual({
      name: 'my-extension',
    });
  });

  it('is case-sensitive on the prefix', () => {
    expect(parseExtensionRef('EXT:browser')).toBeNull();
    expect(parseExtensionRef('Ext:browser')).toBeNull();
  });
});

describe('buildExtensionRef', () => {
  it('produces ext:<name>', () => {
    expect(buildExtensionRef('browser')).toBe('ext:browser');
    expect(buildExtensionRef('my-ext')).toBe('ext:my-ext');
  });

  it('uses the EXTENSION_REF_PREFIX constant', () => {
    expect(buildExtensionRef('foo').startsWith(EXTENSION_REF_PREFIX)).toBe(
      true,
    );
  });
});

describe('matchExtensionByRef', () => {
  const extensions = [
    makeExtension({
      name: 'browser',
      config: { name: 'browser', version: '1.0.0' },
    }),
    makeExtension({
      name: 'github',
      config: { name: 'github', version: '1.0.0' },
    }),
  ];

  it('matches case-insensitively by name', () => {
    expect(matchExtensionByRef('Browser', extensions)?.name).toBe('browser');
    expect(matchExtensionByRef('GITHUB', extensions)?.name).toBe('github');
  });

  it('matches by config.name', () => {
    expect(matchExtensionByRef('browser', extensions)?.name).toBe('browser');
  });

  it('returns undefined for no match', () => {
    expect(matchExtensionByRef('nonexistent', extensions)).toBeUndefined();
  });

  it('does not match by displayName (intentionally excluded)', () => {
    const exts = [
      makeExtension({
        name: 'code-assist',
        displayName: 'Code Assistant',
        config: { name: 'code-assist', version: '1.0.0' },
      }),
    ];
    expect(matchExtensionByRef('Code Assistant', exts)).toBeUndefined();
    expect(matchExtensionByRef('code-assist', exts)?.name).toBe('code-assist');
  });
});

describe('getExtensionSuggestions', () => {
  it('returns empty for undefined config', () => {
    expect(getExtensionSuggestions(undefined, '')).toEqual([]);
  });

  it('returns empty when no active extensions', () => {
    const config = {
      getActiveExtensions: () => [],
    } as unknown as Config;
    expect(getExtensionSuggestions(config, '')).toEqual([]);
  });

  it('returns all extensions on empty pattern', () => {
    const config = {
      getActiveExtensions: () => [
        makeExtension({ name: 'alpha' }),
        makeExtension({ name: 'beta' }),
      ],
    } as unknown as Config;
    const suggestions = getExtensionSuggestions(config, '');
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]!.value).toBe('ext:alpha');
    expect(suggestions[1]!.value).toBe('ext:beta');
  });

  it('filters by substring match', () => {
    const config = {
      getActiveExtensions: () => [
        makeExtension({ name: 'browser' }),
        makeExtension({ name: 'github' }),
        makeExtension({ name: 'pdf' }),
      ],
    } as unknown as Config;
    const suggestions = getExtensionSuggestions(config, 'bro');
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.value).toBe('ext:browser');
  });

  it('prefers prefix matches in sort order', () => {
    const config = {
      getActiveExtensions: () => [
        makeExtension({
          name: 'sub-browser',
          displayName: 'Sub Browser',
        }),
        makeExtension({
          name: 'browser',
          displayName: 'Browser',
        }),
      ],
    } as unknown as Config;
    const suggestions = getExtensionSuggestions(config, 'bro');
    expect(suggestions[0]!.value).toBe('ext:browser');
    expect(suggestions[1]!.value).toBe('ext:sub-browser');
  });

  it('includes sourceBadge and description', () => {
    const config = {
      getActiveExtensions: () => [
        makeExtension({
          name: 'test',
          config: {
            name: 'test',
            version: '1.0.0',
            description: 'Test description',
          },
        }),
      ],
    } as unknown as Config;
    const suggestions = getExtensionSuggestions(config, '');
    expect(suggestions[0]!.sourceBadge).toBe('Extension');
    expect(suggestions[0]!.description).toBe('Test description');
    expect(suggestions[0]!.isDirectory).toBe(false);
    expect(suggestions[0]!.category).toBe('extension');
  });

  it('returns empty when folder is not trusted', () => {
    const config = {
      isTrustedFolder: () => false,
      getActiveExtensions: () => [makeExtension({ name: 'browser' })],
    } as unknown as Config;
    expect(getExtensionSuggestions(config, '')).toEqual([]);
  });

  it('caps results at MAX_SUGGESTIONS_TO_SHOW', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      makeExtension({ name: `ext-${String(i).padStart(2, '0')}` }),
    );
    const config = {
      getActiveExtensions: () => many,
    } as unknown as Config;
    const suggestions = getExtensionSuggestions(config, '');
    expect(suggestions).toHaveLength(MAX_SUGGESTIONS_TO_SHOW);
  });

  it('filters by displayName when name does not match', () => {
    const config = {
      getActiveExtensions: () => [
        makeExtension({
          name: 'code-ast',
          displayName: 'Code Assistant',
        }),
      ],
    } as unknown as Config;
    const suggestions = getExtensionSuggestions(config, 'assist');
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.value).toBe('ext:code-ast');
  });

  it('strips terminal control sequences from label and description', () => {
    const config = {
      getActiveExtensions: () => [
        makeExtension({
          name: 'evil',
          displayName: '\x1b[31mEvil\x1b[0m',
          config: {
            name: 'evil',
            version: '1.0.0',
            description: '\x1b[1mBad desc\x1b[0m',
          },
        }),
      ],
    } as unknown as Config;
    const suggestions = getExtensionSuggestions(config, '');
    expect(suggestions[0]!.label).not.toContain('\x1b');
    expect(suggestions[0]!.description).not.toContain('\x1b');
  });
});

describe('buildExtensionContextText', () => {
  it('produces a context block for a minimal extension', () => {
    const ext = makeExtension({
      name: 'minimal',
      config: { name: 'minimal', version: '1.0.0' },
    });
    const text = buildExtensionContextText(ext);
    expect(text).toContain(
      '--- Extension: minimal (untrusted third-party content) ---',
    );
    expect(text).toContain('--- End Extension: minimal ---');
    expect(text).not.toContain('Available capabilities');
  });

  it('includes description when present', () => {
    const ext = makeExtension({
      config: { name: 'test', version: '1.0.0', description: 'My description' },
    });
    const text = buildExtensionContextText(ext);
    expect(text).toContain('My description');
  });

  it('lists skills, MCP servers, and agents', () => {
    const ext = makeExtension({
      name: 'full',
      displayName: 'Full Extension',
      config: { name: 'full', version: '1.0.0', description: 'Full' },
      skills: [
        { name: 'skill-a' } as SkillConfig,
        { name: 'skill-b' } as SkillConfig,
      ],
      mcpServers: {
        'server-1': {} as MCPServerConfig,
        'server-2': {} as MCPServerConfig,
      },
      agents: [{ name: 'agent-x' } as SubagentConfig],
    });
    const text = buildExtensionContextText(ext);
    expect(text).toContain('Available capabilities');
    expect(text).toContain('Skills: skill-a, skill-b');
    expect(text).toContain('MCP Servers: server-1, server-2');
    expect(text).toContain('Agents: agent-x');
  });

  it('uses displayName when available', () => {
    const ext = makeExtension({
      name: 'test',
      displayName: 'My Test Extension',
      config: { name: 'test', version: '1.0.0' },
    });
    const text = buildExtensionContextText(ext);
    expect(text).toContain('Extension: My Test Extension');
  });
});
