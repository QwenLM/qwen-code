/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { Kind } from '../tools/tools.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import {
  canonicalToolName,
  resolveRegisteredToolName,
  ToolNames,
} from '../tools/tool-names.js';

// Read-only discovery tools registered outside the Read/Search/Fetch kinds.
// `lsp` and `tool_search` are `Kind.Other` — retyping them would also enrol
// them in CONCURRENCY_SAFE_KINDS, a scheduler behaviour change this feature
// must not make — yet both are first-party read-only discovery surfaces the
// model is explicitly steered toward (LSP's own description says to prefer it
// over grep/glob), and classifying them as phase resets makes the reminder
// structurally unreachable for `lsp → read_file → lsp` investigations.
const READ_ONLY_DISCOVERY_TOOLS = new Set<string>([
  ToolNames.LSP,
  ToolNames.TOOL_SEARCH,
]);

export const TOOL_EXPLORATION_REMINDER =
  'System: this read-only exploration phase has reached the configured tool-call allowance. Review the information already gathered before continuing discovery. For an implementation request, proceed to the requested deliverable or explain the concrete blocker. For a read-only investigation, summarize the findings and identify any remaining question. Continue tools only to resolve a specific remaining gap or perform necessary verification. This reminder does not authorize writes or bypass plan approval or tool permissions.';

export function getToolExplorationKind(
  registry: ToolRegistry,
  name: string,
  args: object,
): Kind | undefined {
  const bridged =
    name === ToolNames.TOOL_CALL &&
    typeof (args as Record<string, unknown>)['name'] === 'string';
  const target = bridged
    ? ((args as Record<string, unknown>)['name'] as string)
    : name;
  const canonical = canonicalToolName(target);
  const resolved = resolveRegisteredToolName(
    canonical,
    registry.getAllToolNames(),
  );
  if (Array.isArray(resolved)) return undefined;
  // The bridge unconditionally refuses these two targets
  // (tools/tool-call.ts), so a bridged call to either performs no read and
  // must stay unclassified like a name the registry refuses.
  if (
    bridged &&
    (resolved === ToolNames.TOOL_SEARCH || resolved === ToolNames.TOOL_CALL)
  ) {
    return undefined;
  }
  // Keyed on the registry's answer: `resolved` is `undefined` when the
  // session never registered this name (LSP disabled, `--exclude-tools`
  // removed `tool_search`), and a name the registry refuses must stay
  // unclassified like every other unregistered name instead of being
  // credited as progress.
  if (resolved !== undefined && READ_ONLY_DISCOVERY_TOOLS.has(resolved)) {
    return Kind.Read;
  }
  return registry.getTool(resolved ?? canonical)?.kind;
}

export class ToolExplorationBudget {
  private calls = 0;
  private reminded = false;
  private committedCalls = 0;
  private committedReminded = false;

  record(kind: Kind | undefined): void {
    if (kind === Kind.Read || kind === Kind.Search || kind === Kind.Fetch) {
      this.calls++;
    } else {
      // A non-read ends the phase, and reset() commits the zeroed floor so a
      // later rollback cannot resurrect the previous phase's count or latch.
      this.reset();
    }
  }

  takeReminder(allowance: number): string | undefined {
    if (
      !Number.isFinite(allowance) ||
      allowance <= 0 ||
      this.calls < allowance ||
      this.reminded
    )
      return undefined;
    this.reminded = true;
    this.committedReminded = true;
    return TOOL_EXPLORATION_REMINDER;
  }

  commit(): void {
    this.committedCalls = this.calls;
    this.committedReminded = this.reminded;
  }

  rollback(): void {
    this.calls = this.committedCalls;
    this.reminded = this.committedReminded;
  }

  reset(): void {
    this.calls = 0;
    this.reminded = false;
    this.commit();
  }
}
