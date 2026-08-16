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
  it('throws CopilotRouteError for unknown claude-*', () => {
    expect(() => routeForModel('claude-unknown')).toThrow();
  });
  it('throws CopilotRouteError for unknown gpt-5* (non -chat)', () => {
    expect(() => routeForModel('gpt-5-unknown')).toThrow();
  });
  it('live catalog (Tier 1) overrides static allowlist', () => {
    const live = new Map<string, CopilotWire>([['claude-future', 'responses']]);
    expect(routeForModel('claude-future', undefined, live)).toBe('responses');
  });
});
