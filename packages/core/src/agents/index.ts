/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Multi-agent infrastructure shared across Arena, Team, and Swarm modes.
 *
 * This module provides the common building blocks for managing multiple concurrent
 * agent subprocesses:
 * - Backend: Display abstraction (tmux, iTerm2)
 * - Shared types for agent spawning and lifecycle
 */

export * from './backends/index.js';
export * from './arena/index.js';
export * from './runtime/index.js';
export * from './background-agent-resume.js';
export * from './tasks/types.js';
export * from './tasks/agent-task.js';
export * from './tasks/shell-task.js';
export * from './tasks/monitor-task.js';
export * from './tasks/dream-task.js';
export * from './tasks/registry.js';
export * from './tasks/dispatcher.js';
