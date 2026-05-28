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

    expect(registerLazy).toHaveBeenCalledTimes(9);
    expect(registered).toHaveLength(9);
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

    // registerLazy IS called for all 9 (the gate runs inside it), but only
    // 7 land in `registered` because click + drag were denied.
    expect(registerLazy).toHaveBeenCalledTimes(9);
    expect(registered).toHaveLength(7);
    expect(registered).not.toContain('computer_use__click');
    expect(registered).not.toContain('computer_use__drag');
  });
});
