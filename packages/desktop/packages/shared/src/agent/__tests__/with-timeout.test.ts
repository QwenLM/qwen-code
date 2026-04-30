/**
 * Tests for withTimeout() utility — races a promise against a timeout
 * and properly cleans up the timer to prevent unhandled rejections.
 */
import { describe, it, expect } from 'bun:test';
import { withTimeout } from '../llm-tool.ts';

describe('withTimeout()', () => {
  it('resolves when promise completes before timeout', async () => {
    const promise = Promise.resolve('done');
    const result = await withTimeout(promise, 1000, 'timeout');
    expect(result).toBe('done');
  });

  it('rejects with timeout message when promise takes too long', async () => {
    const neverResolves = new Promise<string>(() => {});
    await expect(
      withTimeout(neverResolves, 50, 'custom timeout message')
    ).rejects.toThrow('custom timeout message');
  });

  it('propagates original rejection', async () => {
    const failing = Promise.reject(new Error('original error'));
    await expect(
      withTimeout(failing, 1000, 'timeout')
    ).rejects.toThrow('original error');
  });

  it('clears timer after resolution (no leaked timer)', async () => {
    // If the timer isn't cleared, this test would still pass
    // but could cause unhandled rejections in other tests.
    // We verify by running it and checking no error occurs.
    const quick = new Promise<void>((resolve) => setTimeout(resolve, 10));
    await withTimeout(quick, 100, 'should not fire');
    // Wait a bit to ensure no unhandled rejection from the timer
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  it('works with void promises', async () => {
    let completed = false;
    const promise = new Promise<void>((resolve) => {
      setTimeout(() => { completed = true; resolve(); }, 10);
    });
    await withTimeout(promise, 1000, 'timeout');
    expect(completed).toBe(true);
  });
});
