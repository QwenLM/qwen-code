/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordStartupEvent, setStartupEventSink } from './startupEventSink.js';

describe('startupEventSink', () => {
  afterEach(() => {
    setStartupEventSink(null);
  });

  it('is a no-op when no sink is registered', () => {
    // Must not throw, must not interact with anything.
    expect(() => recordStartupEvent('foo')).not.toThrow();
    expect(() => recordStartupEvent('bar', { reason: 'x' })).not.toThrow();
  });

  it('forwards name and attrs to the registered sink', () => {
    const sink = vi.fn();
    setStartupEventSink(sink);

    recordStartupEvent('mcp_server_ready:foo', { outcome: 'ready' });
    recordStartupEvent('gemini_tools_updated');

    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenNthCalledWith(1, 'mcp_server_ready:foo', {
      outcome: 'ready',
    });
    expect(sink).toHaveBeenNthCalledWith(2, 'gemini_tools_updated', undefined);
  });

  it('does not bubble sink exceptions into hot paths', () => {
    const sink = vi.fn(() => {
      throw new Error('sink should not break callers');
    });
    setStartupEventSink(sink);

    expect(() => recordStartupEvent('e')).not.toThrow();
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('lets the caller unset the sink by passing null', () => {
    const sink = vi.fn();
    setStartupEventSink(sink);
    recordStartupEvent('one');
    setStartupEventSink(null);
    recordStartupEvent('two');
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith('one', undefined);
  });
});
