/**
 * Tests for Agent Factory
 *
 * Verifies:
 * - Provider detection from auth type
 * - Backend creation for different providers
 * - LLM connection type mapping
 * - Available providers list
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { join } from 'node:path';
import {
  detectProvider,
  createBackend,
  createAgent,
  fetchBackendModels,
  getAvailableProviders,
  initializeBackendHostRuntime,
  isProviderAvailable,
  connectionTypeToProvider,
  connectionAuthTypeToBackendAuthType,
  providerTypeToAgentProvider,
  resolveSetupTestConnectionHint,
  resolveBackendContext,
  createBackendFromConnection,
  testBackendConnection,
  validateStoredBackendConnection,
} from '../factory.ts';
import type { BackendConfig } from '../types.ts';
import type { Workspace, LlmConnection } from '../../../config/storage.ts';
import type { SessionConfig as Session } from '../../../sessions/storage.ts';
import { ClaudeAgent } from '../../claude-agent.ts';
import { PiAgent } from '../../pi-agent.ts';
import { QwenAgent } from '../../qwen-agent.ts';
import { isValidProviderAuthCombination } from '../../../config/llm-connections.ts';

// Test helpers
function createTestWorkspace(): Workspace {
  return {
    id: 'test-workspace',
    name: 'Test Workspace',
    slug: 'workspace',
    rootPath: '/test/workspace',
    createdAt: Date.now(),
  };
}

function createTestSession(): Session {
  return {
    id: 'test-session',
    name: 'Test Session',
    workspaceRootPath: '/test/workspace',
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    permissionMode: 'ask',
  };
}

function createTestConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    provider: 'anthropic',
    workspace: createTestWorkspace(),
    session: createTestSession(),
    isHeadless: true, // Prevent config watchers from starting
    ...overrides,
  };
}

describe('detectProvider', () => {
  describe('Anthropic authentication types', () => {
    it('should return anthropic for api_key', () => {
      expect(detectProvider('api_key')).toBe('anthropic');
    });

    it('should return anthropic for oauth_token', () => {
      expect(detectProvider('oauth_token')).toBe('anthropic');
    });
  });

  describe('Unknown authentication types', () => {
    it('should default to anthropic for unknown types', () => {
      expect(detectProvider('unknown')).toBe('anthropic');
      expect(detectProvider('')).toBe('anthropic');
    });
  });
});

describe('createBackend / createAgent', () => {
  describe('Anthropic provider', () => {
    it('should create ClaudeAgent for anthropic provider', () => {
      const config = createTestConfig({ provider: 'anthropic' });
      const agent = createBackend(config);

      expect(agent).toBeInstanceOf(ClaudeAgent);
    });
  });

  describe('Pi provider', () => {
    it('should create PiAgent for pi provider', () => {
      const config = createTestConfig({ provider: 'pi' });
      const agent = createBackend(config);

      expect(agent).toBeInstanceOf(PiAgent);
    });
  });

  describe('Qwen provider', () => {
    it('should create QwenAgent for qwen provider', () => {
      const config = createTestConfig({ provider: 'qwen' });
      const agent = createBackend(config);

      expect(agent).toBeInstanceOf(QwenAgent);
    });
  });

  describe('Unknown provider', () => {
    it('should throw for unknown provider', () => {
      const config = createTestConfig({ provider: 'unknown' as any });

      expect(() => createBackend(config)).toThrow('Unknown provider: unknown');
    });
  });

  describe('createAgent alias', () => {
    it('should be an alias for createBackend', () => {
      expect(createAgent).toBe(createBackend);
    });
  });
});

describe('getAvailableProviders', () => {
  it('should return anthropic, pi, and qwen', () => {
    const providers = getAvailableProviders();

    expect(providers).toContain('anthropic');
    expect(providers).toContain('pi');
    expect(providers).toContain('qwen');
    expect(providers).toHaveLength(3);
  });
});

describe('isProviderAvailable', () => {
  it('should return true for anthropic', () => {
    expect(isProviderAvailable('anthropic')).toBe(true);
  });

  it('should return true for pi', () => {
    expect(isProviderAvailable('pi')).toBe(true);
  });

  it('should return true for qwen', () => {
    expect(isProviderAvailable('qwen')).toBe(true);
  });

  it('should return false for unknown provider', () => {
    expect(isProviderAvailable('unknown' as any)).toBe(false);
  });
});

describe('connectionTypeToProvider', () => {
  it('should map anthropic type to anthropic provider', () => {
    expect(connectionTypeToProvider('anthropic')).toBe('anthropic');
  });

  it('should map openai type to pi provider (legacy routing)', () => {
    expect(connectionTypeToProvider('openai')).toBe('pi');
  });

  it('should map openai-compat type to pi provider (legacy routing)', () => {
    expect(connectionTypeToProvider('openai-compat')).toBe('pi');
  });

  it('should default to anthropic for unknown types', () => {
    expect(connectionTypeToProvider('unknown' as any)).toBe('anthropic');
  });
});

describe('connectionAuthTypeToBackendAuthType (legacy)', () => {
  it('should map api_key to api_key', () => {
    expect(connectionAuthTypeToBackendAuthType('api_key')).toBe('api_key');
  });

  it('should pass through oauth', () => {
    expect(connectionAuthTypeToBackendAuthType('oauth')).toBe('oauth');
  });

  it('should map none to undefined', () => {
    expect(connectionAuthTypeToBackendAuthType('none')).toBeUndefined();
  });
});

describe('providerTypeToAgentProvider', () => {
  describe('Anthropic SDK providers', () => {
    it('should map anthropic to anthropic', () => {
      expect(providerTypeToAgentProvider('anthropic')).toBe('anthropic');
    });
  });

  describe('Pi SDK providers', () => {
    it('should map pi to pi', () => {
      expect(providerTypeToAgentProvider('pi')).toBe('pi');
    });

    it('should map pi_compat to pi', () => {
      expect(providerTypeToAgentProvider('pi_compat')).toBe('pi');
    });
  });

  describe('Qwen ACP provider', () => {
    it('should map qwen to qwen', () => {
      expect(providerTypeToAgentProvider('qwen')).toBe('qwen');
    });
  });
});

// ============================================================
// Provider-Auth Validation Tests
// ============================================================

describe('isValidProviderAuthCombination', () => {
  describe('Anthropic provider', () => {
    it('should accept api_key auth', () => {
      expect(isValidProviderAuthCombination('anthropic', 'api_key')).toBe(true);
    });

    it('should accept oauth auth', () => {
      expect(isValidProviderAuthCombination('anthropic', 'oauth')).toBe(true);
    });

    it('should reject api_key_with_endpoint auth', () => {
      expect(isValidProviderAuthCombination('anthropic', 'api_key_with_endpoint')).toBe(false);
    });

    it('should reject none auth', () => {
      expect(isValidProviderAuthCombination('anthropic', 'none')).toBe(false);
    });
  });

  describe('Pi provider', () => {
    it('should accept api_key auth', () => {
      expect(isValidProviderAuthCombination('pi', 'api_key')).toBe(true);
    });

    it('should accept oauth auth', () => {
      expect(isValidProviderAuthCombination('pi', 'oauth')).toBe(true);
    });

    it('should accept none auth', () => {
      expect(isValidProviderAuthCombination('pi', 'none')).toBe(true);
    });
  });

  describe('Pi compat provider', () => {
    it('should accept api_key_with_endpoint auth', () => {
      expect(isValidProviderAuthCombination('pi_compat', 'api_key_with_endpoint')).toBe(true);
    });

    it('should accept none auth (for local models like Ollama)', () => {
      expect(isValidProviderAuthCombination('pi_compat', 'none')).toBe(true);
    });
  });

  describe('Qwen provider', () => {
    it('should accept none auth', () => {
      expect(isValidProviderAuthCombination('qwen', 'none')).toBe(true);
    });

    it('should reject api_key auth', () => {
      expect(isValidProviderAuthCombination('qwen', 'api_key')).toBe(false);
    });
  });

});

describe('phase4 backend abstraction APIs', () => {
  it('initializeBackendHostRuntime bootstraps without throwing in dev runtime', () => {
    expect(() => initializeBackendHostRuntime({
      hostRuntime: {
        appRootPath: process.cwd(),
        isPackaged: false,
      },
    })).not.toThrow();
  });

  // Skip: resolveClaudeCliPath finds the CLI via node_modules traversal even from dist/, so this
  // only fails in a truly isolated packaged environment, not in the dev monorepo.
  it.skip('initializeBackendHostRuntime throws for dist-style host root in dev', () => {
    expect(() => initializeBackendHostRuntime({
      hostRuntime: {
        appRootPath: join(process.cwd(), 'apps', 'electron', 'dist'),
        isPackaged: false,
      },
    })).toThrow('Claude Code SDK not found');
  });

  it('resolveSetupTestConnectionHint maps provider/baseUrl/piAuthProvider correctly', () => {
    expect(resolveSetupTestConnectionHint({
      provider: 'anthropic',
      baseUrl: 'https://api.example.com',
    })).toEqual({ providerType: 'pi_compat' });

    expect(resolveSetupTestConnectionHint({
      provider: 'anthropic',
      baseUrl: '',
    })).toEqual({ providerType: 'anthropic' });

    expect(resolveSetupTestConnectionHint({
      provider: 'pi',
      piAuthProvider: 'openai-codex',
    })).toEqual({ providerType: 'pi', piAuthProvider: 'openai-codex' });

    expect(resolveSetupTestConnectionHint({
      provider: 'pi',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      customEndpoint: { api: 'openai-completions' },
    })).toEqual({ providerType: 'pi_compat', piAuthProvider: 'openai', customEndpoint: { api: 'openai-completions' } });

    expect(resolveSetupTestConnectionHint({
      provider: 'pi',
      baseUrl: 'https://my-anthropic-proxy.internal/v1',
      customEndpoint: { api: 'anthropic-messages' },
    })).toEqual({ providerType: 'pi_compat', piAuthProvider: 'anthropic', customEndpoint: { api: 'anthropic-messages' } });

    expect(resolveSetupTestConnectionHint({
      provider: 'qwen',
    })).toEqual({ providerType: 'qwen' });
  });

  it('resolveBackendContext treats qwen-code as a built-in connection', () => {
    const context = resolveBackendContext({
      sessionConnectionSlug: 'qwen-code',
    });

    expect(context.connection?.slug).toBe('qwen-code');
    expect(context.connection?.providerType).toBe('qwen');
    expect(context.connection?.authType).toBe('none');
    expect(context.provider).toBe('qwen');
    expect(context.capabilities.listsSessions).toBe(true);
  });

  it('fetchBackendModels dispatches for pi provider', async () => {
    const connection: LlmConnection = {
      slug: 'pi-test',
      name: 'Pi Test',
      providerType: 'pi',
      authType: 'none',
      createdAt: Date.now(),
    };

    const result = await fetchBackendModels({
      connection,
      credentials: {},
      hostRuntime: {
        appRootPath: process.cwd(),
        isPackaged: false,
      },
    });

    expect(result.models.length).toBeGreaterThan(0);
  });

  it('validateStoredBackendConnection returns not found for unknown slug', async () => {
    const result = await validateStoredBackendConnection({
      slug: '__missing-connection__',
      hostRuntime: {
        appRootPath: process.cwd(),
        isPackaged: false,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Connection not found');
  });

  it('testBackendConnection keeps required model argument and validates key presence', async () => {
    const result = await testBackendConnection({
      provider: 'anthropic',
      apiKey: '   ',
      model: 'claude-sonnet-4-6',
      hostRuntime: {
        appRootPath: process.cwd(),
        isPackaged: false,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('API key is required');
  });
});

describe('ClaudeAgent model switching', () => {
  it('setModel updates getModel (regression: setModel used to write config.model but getModel reads _model)', () => {
    const agent = createBackend(createTestConfig({ provider: 'anthropic', model: 'claude-opus-4-7' }));

    expect(agent.getModel()).toBe('claude-opus-4-7');

    agent.setModel('claude-sonnet-4-6');

    expect(agent.getModel()).toBe('claude-sonnet-4-6');
  });
});
