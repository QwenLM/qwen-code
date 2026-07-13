import { describe, expect, it } from 'vitest';
import type { DaemonExtensionEntry } from '@qwen-code/sdk/daemon';
import {
  filterExtensions,
  preserveSelectedExtensionName,
} from './extensions-manager-logic';

function extension(
  name: string,
  displayName?: string,
  description?: string,
): DaemonExtensionEntry {
  return {
    kind: 'extension',
    id: name,
    name,
    displayName,
    description,
    version: '1.0.0',
    isActive: true,
    path: `/tmp/${name}`,
    capabilities: {
      mcpServerCount: 0,
      skillCount: 0,
      agentCount: 0,
      hookCount: 0,
      commandCount: 0,
      contextFileCount: 0,
      channelCount: 0,
      hasSettings: false,
    },
  };
}

describe('extensions manager logic', () => {
  const extensions = [
    extension('gsd-core', 'GSD Core', 'Spec-driven development'),
    extension('browser-tools', 'Browser Tools', 'Browser automation'),
  ];

  it('filters by name, display name, and description', () => {
    expect(filterExtensions(extensions, 'GSD')).toEqual([extensions[0]]);
    expect(filterExtensions(extensions, 'automation')).toEqual([extensions[1]]);
  });

  it('keeps a selected extension only while it remains installed', () => {
    expect(preserveSelectedExtensionName('gsd-core', extensions)).toBe(
      'gsd-core',
    );
    expect(preserveSelectedExtensionName('removed', extensions)).toBeNull();
  });
});
