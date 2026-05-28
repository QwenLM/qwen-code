import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComputerUseClient } from './client.js';

describe('ComputerUseClient', () => {
  let client: ComputerUseClient;

  beforeEach(() => {
    client = new ComputerUseClient({
      packageSpec: 'open-computer-use@latest',
      onProgress: vi.fn(),
    });
  });

  it('is constructible', () => {
    expect(client).toBeDefined();
  });

  it('reports not-started before start() is called', () => {
    expect(client.isStarted()).toBe(false);
  });

  it('returns the same instance for repeated callers via singleton', () => {
    const a = ComputerUseClient.shared();
    const b = ComputerUseClient.shared();
    expect(a).toBe(b);
  });
});
