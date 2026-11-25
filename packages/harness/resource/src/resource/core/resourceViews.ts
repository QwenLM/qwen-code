/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AgentResourceDefinition,
  AgentResourceLoadError,
} from '../kinds/agents/types.js';
import type {
  OutputStyleConfig,
  OutputStyleLoadError,
} from '../kinds/outputStyles/types.js';
import type {
  SkillDefinition,
  SkillLoadError,
} from '../kinds/skills/types.js';
import type { ResourceChangeEvent } from './types.js';

export interface SkillResourceSnapshot {
  discoveredSkills: readonly SkillDefinition[];
  loadErrors: readonly SkillLoadError[];
}

export interface AgentResourceSnapshot {
  discoveredAgents: readonly AgentResourceDefinition[];
  loadErrors: readonly AgentResourceLoadError[];
}

export interface OutputStyleResourceSnapshot {
  discoveredOutputStyles: readonly OutputStyleConfig[];
  loadErrors: readonly OutputStyleLoadError[];
}

/**
 * Per-scope Skill candidates: one load order (compat directories first,
 * selected directories after), canonical-path dedup, and load errors. The
 * cross-scope winner and shadow bookkeeping belong to the host.
 */
export interface SkillResourceView {
  getAllDiscoveredSkills(): SkillDefinition[];
  getLoadErrors(): readonly SkillLoadError[];
  onDidChange(listener: SkillResourceChangeListener): () => void;
}

/**
 * Receives subscriber-local events and the candidate snapshot of that
 * refresh. Treat them as read-only; querying the resource during an await
 * may return a newer snapshot. Notifications can overlap and finish out of
 * order, so consumers must guard stale application. Explicit reload
 * notifications omit file events.
 */
export type SkillResourceChangeListener = (
  events: readonly ResourceChangeEvent[] | undefined,
  snapshot: SkillResourceSnapshot,
) => void | Promise<void>;

/** Per-scope Agent candidates in discovery order; precedence is host-owned. */
export interface AgentResourceView {
  getAllDiscoveredAgents(): AgentResourceDefinition[];
  getLoadErrors(): readonly AgentResourceLoadError[];
}

/**
 * Per-scope Output Style candidates in discovery order; selection remains
 * host-owned.
 */
export interface OutputStyleResourceView {
  getAllDiscoveredOutputStyles(): OutputStyleConfig[];
  getLoadErrors(): readonly OutputStyleLoadError[];
}
