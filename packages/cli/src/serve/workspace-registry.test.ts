/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  createSingleWorkspaceRegistry,
  type WorkspaceRuntime,
} from './workspace-registry.js';

describe('createSingleWorkspaceRegistry', () => {
  it('exposes the supplied runtime as the primary and only runtime', () => {
    const runtime = { workspaceCwd: '/work/primary' } as WorkspaceRuntime;

    const registry = createSingleWorkspaceRegistry(runtime);

    expect(registry.primary).toBe(runtime);
    expect(registry.list()).toEqual([runtime]);
    expect(registry.list()[0]).toBe(runtime);
  });

  it('looks up only the exact canonical workspace string', () => {
    const runtime = { workspaceCwd: '/work/primary' } as WorkspaceRuntime;

    const registry = createSingleWorkspaceRegistry(runtime);

    expect(registry.getByWorkspaceCwd('/work/primary')).toBe(runtime);
    expect(registry.getByWorkspaceCwd('/work')).toBeUndefined();
    expect(registry.getByWorkspaceCwd('/work/primary/child')).toBeUndefined();
    expect(registry.getByWorkspaceCwd('/work/primary/')).toBeUndefined();
    expect(registry.getByWorkspaceCwd('/other')).toBeUndefined();
  });
});
