/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The two argv tokens the CLI entry has to recognize before it parses
 * anything.
 *
 * Their own module because the entry decides on every launch, and both
 * decisions must cost nothing when the answer is no: importing either the
 * supervisor runtime or the dispatch path to read one string would put
 * them on the startup path of every `qwen` invocation.
 */
export const INTERNAL_AGENT_VIEW_SUPERVISOR_ARG =
  '--internal-agent-view-supervisor';

/** The flag that asks for a background session. */
export const BACKGROUND_FLAG = '--bg';
