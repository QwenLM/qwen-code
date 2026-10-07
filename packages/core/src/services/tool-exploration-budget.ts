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

export const TOOL_EXPLORATION_REMINDER =
  'System: this read-only exploration phase has reached the configured tool-call allowance. Review the information already gathered before continuing discovery. For an implementation request, proceed to the requested deliverable or explain the concrete blocker. For a read-only investigation, summarize the findings and identify any remaining question. Continue tools only to resolve a specific remaining gap or perform necessary verification. This reminder does not authorize writes or bypass plan approval or tool permissions.';

export function getToolExplorationKind(
  registry: ToolRegistry,
  name: string,
  args: object,
): Kind | undefined {
  const target =
    name === ToolNames.TOOL_CALL &&
    typeof (args as Record<string, unknown>)['name'] === 'string'
      ? ((args as Record<string, unknown>)['name'] as string)
      : name;
  const canonical = canonicalToolName(target);
  const resolved = resolveRegisteredToolName(
    canonical,
    registry.getAllToolNames(),
  );
  if (Array.isArray(resolved)) return undefined;
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
      this.calls = 0;
      this.reminded = false;
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
