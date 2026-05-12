/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Per-run AsyncLocalStorage frame for agent execution.
 *
 * Tools capture `this.config` at construction time, so a sub-agent running
 * with a different model cannot rely on the constructor-bound Config to
 * report the right ContentGenerator or modalities. This frame lets
 * `Config.getContentGenerator{,Config}()` resolve to the active sub-agent
 * view, and lets nested `agent` tool launches discover their parent's id —
 * both without threading extra parameters through every call site.
 *
 * Helpers patch one field at a time and merge with whatever is already on
 * the stack, so wrapping at different layers preserves every set field.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../../core/contentGenerator.js';

export interface RuntimeContentGeneratorView {
  readonly contentGenerator: ContentGenerator;
  readonly contentGeneratorConfig: ContentGeneratorConfig;
}

export type AgentExecutionMode = 'root' | 'foreground' | 'background';

interface AgentContext {
  readonly agentId?: string;
  readonly runtimeView?: RuntimeContentGeneratorView;
  readonly agentDepth?: number;
  readonly agentExecutionMode?: AgentExecutionMode;
}

const storage = new AsyncLocalStorage<AgentContext>();
export const AGENT_MAX_DEPTH_ENV = 'QWEN_AGENT_MAX_DEPTH';
export const DEFAULT_AGENT_MAX_DEPTH = 1;

export function runWithAgentContext<T>(
  agentId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const current = storage.getStore() ?? {};
  return storage.run({ ...current, agentId }, fn);
}

export function runWithRuntimeContentGenerator<T>(
  view: RuntimeContentGeneratorView,
  fn: () => Promise<T>,
): Promise<T> {
  const current = storage.getStore() ?? {};
  return storage.run({ ...current, runtimeView: view }, fn);
}

export function runWithAgentDepth<T>(
  agentDepth: number,
  fn: () => Promise<T>,
): Promise<T> {
  const current = storage.getStore() ?? {};
  return storage.run({ ...current, agentDepth }, fn);
}

export function runWithAgentExecutionMode<T>(
  agentExecutionMode: AgentExecutionMode,
  fn: () => Promise<T>,
): Promise<T> {
  const current = storage.getStore() ?? {};
  return storage.run({ ...current, agentExecutionMode }, fn);
}

export function getCurrentAgentId(): string | null {
  return storage.getStore()?.agentId ?? null;
}

export function getCurrentAgentDepth(): number {
  return storage.getStore()?.agentDepth ?? 0;
}

export function getCurrentAgentExecutionMode(): AgentExecutionMode {
  return storage.getStore()?.agentExecutionMode ?? 'root';
}

export function getConfiguredAgentMaxDepth(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[AGENT_MAX_DEPTH_ENV];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_AGENT_MAX_DEPTH;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_AGENT_MAX_DEPTH;
  }

  return Math.floor(parsed);
}

export function getRuntimeContentGenerator():
  | RuntimeContentGeneratorView
  | undefined {
  return storage.getStore()?.runtimeView;
}
