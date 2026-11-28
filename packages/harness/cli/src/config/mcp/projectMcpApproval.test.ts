/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { LoadedSettings, SettingsMutationEditor } from '../settings.js';

import {
  approveProjectMcpServer,
  rejectProjectMcpServer,
  resetProjectMcpChoices,
} from './projectMcpApproval.js';

function createLoaded(root: Record<string, unknown>, succeed = true) {
  const mutateScope = vi.fn((_scope, mutation) => {
    const get = (path: string | readonly string[]) => {
      const keys = typeof path === 'string' ? path.split('.') : [...path];
      return keys.reduce<unknown>(
        (current, key) =>
          current && typeof current === 'object'
            ? (current as Record<string, unknown>)[key]
            : undefined,
        root,
      );
    };
    const set = (path: string | readonly string[], value: unknown) => {
      const keys = typeof path === 'string' ? path.split('.') : [...path];
      const last = keys.pop();
      if (!last) return false;
      let current = root;
      for (const key of keys) {
        const valueAtKey = current[key];
        if (
          !valueAtKey ||
          typeof valueAtKey !== 'object' ||
          Array.isArray(valueAtKey)
        ) {
          current[key] = {};
        }
        current = current[key] as Record<string, unknown>;
      }
      current[last] = value;
      return true;
    };
    mutation({ get, set } as SettingsMutationEditor);
    return succeed;
  });
  const loaded = { mutateScope } as unknown as LoadedSettings;
  return { loaded, mutateScope };
}

describe('project MCP approval persistence', () => {
  it('approves by updating enabled and disabled lists in one mutation', () => {
    const root = {
      mcp: {
        enabledProjectMcpServers: ['keep'],
        disabledProjectMcpServers: ['SERVER', 'other'],
      },
    };
    const { loaded, mutateScope } = createLoaded(root);

    expect(approveProjectMcpServer('server', loaded)).toBe(true);
    expect(mutateScope).toHaveBeenCalledOnce();
    expect(root.mcp).toEqual({
      enabledProjectMcpServers: ['keep', 'server'],
      disabledProjectMcpServers: ['other'],
    });
  });

  it('rejects by updating both lists in one mutation', () => {
    const root = {
      mcp: {
        enabledProjectMcpServers: ['Server', 'keep'],
        disabledProjectMcpServers: [],
      },
    };
    const { loaded, mutateScope } = createLoaded(root);

    expect(rejectProjectMcpServer('server', loaded)).toBe(true);
    expect(mutateScope).toHaveBeenCalledOnce();
    expect(root.mcp).toEqual({
      enabledProjectMcpServers: ['keep'],
      disabledProjectMcpServers: ['server'],
    });
  });

  it('resets all related fields in one mutation and propagates failure', () => {
    const root = { mcp: {} };
    const { loaded, mutateScope } = createLoaded(root, false);

    expect(resetProjectMcpChoices(loaded)).toBe(false);
    expect(mutateScope).toHaveBeenCalledOnce();
    expect(root.mcp).toEqual({
      enabledProjectMcpServers: [],
      disabledProjectMcpServers: [],
      enableAllProjectMcpServers: false,
    });
  });
});
