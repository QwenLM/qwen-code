/**
 * Test utilities for agent tests
 *
 * Provides mock factories and helpers for testing agent implementations.
 */

import type { AgentEvent } from '@craft-agent/core/types';
import type { BackendConfig, ChatOptions } from '../backend/types.ts';
import { AbortReason } from '../backend/types.ts';
import type { Workspace } from '../../config/storage.ts';
import type { SessionConfig as Session } from '../../sessions/storage.ts';
import type { LoadedSource } from '../../sources/types.ts';
import { BaseAgent } from '../base-agent.ts';

// ============================================================
// Mock Workspace Factory
// ============================================================

/**
 * Create a mock Workspace object for testing.
 */
export function createMockWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'test-workspace-id',
    name: 'Test Workspace',
    slug: 'workspace',
    rootPath: '/test/workspace',
    createdAt: Date.now(),
    ...overrides,
  };
}

// ============================================================
// Mock Session Factory
// ============================================================

/**
 * Create a mock Session object for testing.
 */
export function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'test-session-id',
    name: 'Test Session',
    workspaceRootPath: '/test/workspace',
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    permissionMode: 'ask',
    ...overrides,
  };
}

// ============================================================
// Mock Source Factory
// ============================================================

/**
 * Create a mock LoadedSource object for testing.
 */
export function createMockSource(overrides: Partial<LoadedSource['config']> = {}): LoadedSource {
  return {
    config: {
      id: 'test-source-id',
      name: 'Test Source',
      slug: 'test-source',
      enabled: true,
      provider: 'test',
      type: 'mcp',
      ...overrides,
    },
    guide: null,
    folderPath: '/test/source',
    workspaceRootPath: '/test/workspace',
    workspaceId: 'test-workspace-id',
  };
}

// ============================================================
// Mock BackendConfig Factory
// ============================================================

/**
 * Create a mock BackendConfig for testing.
 */
export function createMockBackendConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    provider: 'qwen',
    workspace: createMockWorkspace(),
    session: createMockSession(),
    model: 'test-model',
    thinkingLevel: 'medium',
    isHeadless: true, // Headless mode to avoid config watcher
    ...overrides,
  };
}

// ============================================================
// TestAgent - Concrete BaseAgent for Testing
// ============================================================

/**
 * Concrete implementation of BaseAgent for testing.
 * Provides minimal implementations of abstract methods.
 */
export class TestAgent extends BaseAgent {
  protected backendName = 'Test';
  // Track calls for verification
  public chatCalls: Array<{ message: string; attachments?: unknown[]; options?: ChatOptions }> = [];
  public abortCalls: Array<{ reason?: string }> = [];
  public forceAbortCalls: Array<{ reason: AbortReason }> = [];
  public respondToPermissionCalls: Array<{ requestId: string; allowed: boolean; alwaysAllow?: boolean }> = [];

  private _isProcessing: boolean = false;

  constructor(config: BackendConfig) {
    super(config, 'test-model', 100_000);
  }

  protected async *chatImpl(
    message: string,
    attachments?: unknown[],
    options?: ChatOptions
  ): AsyncGenerator<AgentEvent> {
    this.chatCalls.push({ message, attachments, options });
    this._isProcessing = true;
    try {
      yield { type: 'complete' };
    } finally {
      this._isProcessing = false;
    }
  }

  async abort(reason?: string): Promise<void> {
    this.abortCalls.push({ reason });
    this._isProcessing = false;
  }

  forceAbort(reason: AbortReason = AbortReason.UserStop): void {
    this.forceAbortCalls.push({ reason });
    this._isProcessing = false;
  }

  isProcessing(): boolean {
    return this._isProcessing;
  }

  respondToPermission(requestId: string, allowed: boolean, alwaysAllow?: boolean): void {
    this.respondToPermissionCalls.push({ requestId, allowed, alwaysAllow });
  }

  async runMiniCompletion(_prompt: string): Promise<string | null> {
    return 'Test Response';
  }

  async queryLlm(_request: import('../llm-tool.ts').LLMQueryRequest): Promise<import('../llm-tool.ts').LLMQueryResult> {
    return { text: 'Test LLM Response' };
  }

  // Expose protected state for testing
  getConfigWatcherManager() { return this.configWatcherManager; }

  // Helper to reset tracking
  resetTracking(): void {
    this.chatCalls = [];
    this.abortCalls = [];
    this.forceAbortCalls = [];
    this.respondToPermissionCalls = [];
  }
}

// ============================================================
// Event Collector Utility
// ============================================================

/**
 * Collect all events from an AsyncGenerator.
 */
export async function collectEvents(generator: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

// ============================================================
// Callback Spy Utility
// ============================================================

/**
 * Create a callback spy that records all calls.
 */
export function createCallbackSpy<T extends (...args: unknown[]) => unknown>(): {
  spy: T;
  calls: Parameters<T>[];
} {
  const calls: Parameters<T>[] = [];
  const spy = ((...args: Parameters<T>) => {
    calls.push(args);
  }) as T;
  return { spy, calls };
}
