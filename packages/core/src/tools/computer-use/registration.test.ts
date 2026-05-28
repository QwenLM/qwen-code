import { describe, it, expect, vi } from 'vitest';
import { registerComputerUseTools } from './index.js';
import { COMPUTER_USE_TOOL_NAMES } from './schemas.js';

describe('registerComputerUseTools', () => {
  it('registers a factory for each of the 9 upstream tools, prefixed with computer_use__', () => {
    const registered = new Set<string>();
    const fakeRegistry = {
      registerFactory: vi.fn((name: string) => {
        registered.add(name);
      }),
    } as never;

    registerComputerUseTools(fakeRegistry);

    expect(registered.size).toBe(9);
    for (const name of COMPUTER_USE_TOOL_NAMES) {
      expect(registered.has(`computer_use__${name}`)).toBe(true);
    }
  });
});
