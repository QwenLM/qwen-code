import { describe, expect, it } from 'vitest';
import { regionsToCapabilities } from './capabilities.js';

describe('regionsToCapabilities', () => {
  it('defaults every region to hidden', () => {
    const capabilities = regionsToCapabilities([]);
    expect(Object.values(capabilities).every((value) => value === false)).toBe(
      true,
    );
  });

  it('enables exactly the given regions', () => {
    const capabilities = regionsToCapabilities(['terminal', 'tasks']);
    expect(capabilities.terminal).toBe(true);
    expect(capabilities.tasks).toBe(true);
    expect(capabilities.modelSelection).toBe(false);
    expect(capabilities.usageStats).toBe(false);
  });
});
