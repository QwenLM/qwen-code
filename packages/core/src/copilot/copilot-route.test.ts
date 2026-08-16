// packages/core/src/copilot/copilot-route.test.ts
import { describe, it, expect, vi } from 'vitest';
import { routeForModel } from './copilot-route.js';
import type { CopilotWire } from './copilot-route.js';

describe('routeForModel', () => {
  it('routes claude-opus-4.6 to messages', () => {
    expect(routeForModel('claude-opus-4.6')).toBe('messages');
  });
  it('routes claude-sonnet-4.7 to messages', () => {
    expect(routeForModel('claude-sonnet-4.7')).toBe('messages');
  });
  it('routes claude-sonnet-5 to messages (pattern, not hardcoded list)', () => {
    expect(routeForModel('claude-sonnet-5')).toBe('messages');
  });
  it('routes gpt-5.2 to responses', () => {
    expect(routeForModel('gpt-5.2')).toBe('responses');
  });
  it('routes gpt-5-codex to responses', () => {
    expect(routeForModel('gpt-5-codex')).toBe('responses');
  });
  it('routes anthropic.claude-opus-4.6 (provider-prefixed) to messages', () => {
    expect(routeForModel('anthropic.claude-opus-4.6')).toBe('messages');
  });
  it('routes gpt-4o to chat', () => {
    expect(routeForModel('gpt-4o')).toBe('chat');
  });
  it('routes unknown model to chat with warning', () => {
    const warn = vi.fn();
    expect(routeForModel('unknown-model', warn)).toBe('chat');
    expect(warn).toHaveBeenCalled();
  });
  it('routes unknown claude-* to messages via pattern (no throw)', () => {
    const warn = vi.fn();
    expect(routeForModel('claude-unknown', warn)).toBe('messages');
    expect(warn).not.toHaveBeenCalled();
  });
  it('routes unknown gpt-5* to responses via pattern (no throw)', () => {
    const warn = vi.fn();
    expect(routeForModel('gpt-5-unknown', warn)).toBe('responses');
    expect(warn).not.toHaveBeenCalled();
  });
  it('routes future claude-sonnet-9.9 to messages without code changes', () => {
    expect(routeForModel('claude-sonnet-9.9')).toBe('messages');
  });
  it('routes future gpt-5.9-codex to responses without code changes', () => {
    expect(routeForModel('gpt-5.9-codex')).toBe('responses');
  });
  it('routes anthropic.claude-future (provider-prefixed) to messages', () => {
    expect(routeForModel('anthropic.claude-future')).toBe('messages');
  });
  it('live catalog (Tier 1) overrides pattern routing', () => {
    const live = new Map<string, CopilotWire>([['claude-future', 'responses']]);
    expect(routeForModel('claude-future', undefined, live)).toBe('responses');
  });
});
