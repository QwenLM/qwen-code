import { describe, it, expect } from 'vitest';
import { plugin } from './index.js';

describe('aone plugin descriptor', () => {
  it('declares groupPolicy with default open (shared injection defaults to disabled)', () => {
    const field = plugin.management?.fields.find(
      (f) => f.key === 'groupPolicy',
    );
    expect(field).toBeDefined();
    expect(field!.kind).toBe('enum');
    expect(field!.default).toBe('open');
    expect(field!.required).toBe(true);
    if (field!.kind === 'enum') {
      expect(field!.options.map((o) => o.value)).toEqual([
        'open',
        'allowlist',
        'pairing',
        'disabled',
      ]);
    }
  });

  it('requires repos and triggerPrefixes and defaults to chat_thread scope', () => {
    expect(plugin.channelType).toBe('aone');
    expect(plugin.requiredConfigFields).toEqual(['repos', 'triggerPrefixes']);
    expect(plugin.defaultSessionScope).toBe('chat_thread');
  });

  it('validateConfig rejects an empty watch list', () => {
    expect(
      plugin.management?.validateConfig?.({
        repos: [],
        triggerPrefixes: ['qwen:'],
      }),
    ).toMatch(/non-empty array/);
    expect(
      plugin.management?.validateConfig?.({
        repos: ['g/p'],
        triggerPrefixes: ['qwen:'],
      }),
    ).toBeUndefined();
  });
});
