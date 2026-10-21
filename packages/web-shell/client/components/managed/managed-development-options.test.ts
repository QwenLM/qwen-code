import { describe, expect, it } from 'vitest';
import { managedDevelopmentOptions } from './managed-development-options';

describe('managedDevelopmentOptions', () => {
  it('keeps the tenant-only legacy development configuration', () => {
    const options = managedDevelopmentOptions(
      new URLSearchParams('tenant=demo'),
      {},
    );
    expect(options.productScope).toBe('demo');
    expect(options.getHeaders?.()).toEqual({ 'X-Qwen-Tenant-Id': 'demo' });
    expect(options.enableWorkspaceBinding).toBe(false);
  });

  it('scopes authorized Workspace selection by tenant and actor', () => {
    const options = managedDevelopmentOptions(
      new URLSearchParams('tenant=demo&managedWorkspace=1'),
      {
        VITE_MANAGED_AGENT_ACTOR_ID: 'owner',
        VITE_MANAGED_AGENT_MODEL_PRESETS:
          '[{"agentId":"agent-a","label":"Model A"}]',
      },
    );
    expect(options.enableWorkspaceBinding).toBe(true);
    expect(options.productScope).toBe(JSON.stringify(['demo', 'owner']));
    expect(options.getHeaders?.()).toEqual({
      'X-Qwen-Tenant-Id': 'demo',
      'X-Qwen-Actor-Id': 'owner',
    });
    expect(options.modelPresets).toEqual([
      { agentId: 'agent-a', label: 'Model A' },
    ]);
    expect(
      managedDevelopmentOptions(new URLSearchParams('tenant=demo'), {
        VITE_MANAGED_AGENT_ACTOR_ID: 'another-owner',
      }).productScope,
    ).not.toBe(options.productScope);
  });

  it.each([
    '{}',
    '[{"agentId":"a"}]',
    '[{"agentId":"a","label":" "}]',
    '[{"agentId":"a","label":"A"},{"agentId":"a","label":"B"}]',
  ])('refuses malformed or ambiguous preset configuration %s', (value) => {
    expect(() =>
      managedDevelopmentOptions(new URLSearchParams(), {
        VITE_MANAGED_AGENT_MODEL_PRESETS: value,
      }),
    ).toThrow();
  });
});
