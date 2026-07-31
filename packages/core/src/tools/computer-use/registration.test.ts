import { describe, it, expect, vi } from 'vitest';
import { registerComputerUseTools } from './index.js';
import { COMPUTER_USE_TOOL_NAMES } from './schemas.js';

describe('registerComputerUseTools', () => {
  it('calls registerLazy once per upstream tool with the computer_use__ prefix', async () => {
    // Contract: registration goes through the caller-supplied registerLazy
    // (the helper from Config.createToolRegistry that runs
    // PermissionManager.isToolEnabled). Direct registry.registerFactory
    // would bypass the coreTools allowlist and whole-tool deny rules —
    // see PR #4590 review (DragonnZhang).
    const registered: string[] = [];
    const registerLazy = vi.fn(async (name: string) => {
      registered.push(name);
    });

    await registerComputerUseTools(registerLazy as never);

    expect(registerLazy).toHaveBeenCalledTimes(COMPUTER_USE_TOOL_NAMES.length);
    expect(registered).toHaveLength(COMPUTER_USE_TOOL_NAMES.length);
    for (const name of COMPUTER_USE_TOOL_NAMES) {
      expect(registered).toContain(`computer_use__${name}`);
    }
  });

  it('skips tools that registerLazy chooses not to register (PermissionManager deny)', async () => {
    // Verifies the permission gate is honored: if registerLazy is a no-op
    // for a given tool name (e.g. PermissionManager.isToolEnabled returns
    // false), no factory is invoked for it.
    const denyList = new Set(['computer_use__click', 'computer_use__drag']);
    const registered: string[] = [];
    const registerLazy = vi.fn(
      async (name: string, _factory: () => Promise<unknown>) => {
        if (!denyList.has(name)) registered.push(name);
      },
    );

    await registerComputerUseTools(registerLazy as never);

    // registerLazy IS called for every curated tool (the gate runs inside
    // it), but click + drag are denied so they don't land in `registered`.
    expect(registerLazy).toHaveBeenCalledTimes(COMPUTER_USE_TOOL_NAMES.length);
    expect(registered).toHaveLength(COMPUTER_USE_TOOL_NAMES.length - 2);
    expect(registered).not.toContain('computer_use__click');
    expect(registered).not.toContain('computer_use__drag');
  });
});
