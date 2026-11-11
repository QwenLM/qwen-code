/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ToolRegistry,
  type AnyDeclarativeTool,
  type Config,
  type FileReadRecoverySchemaContext,
  type ToolRegistrySchemaOptions,
} from '@qwen-code/core';
import type { FunctionDeclaration } from '@google/genai';

type MainToolRegistryProvider =
  | ToolRegistry
  | (() => ToolRegistry);

/**
 * A live view of the main registry plus host-only tools.
 *
 * Delegating to the main registry keeps late MCP refreshes visible, while the
 * host layer remains absent from Config and therefore cannot leak into normal
 * CLI sessions or subagent registry construction.
 */
export class RootToolRegistry extends ToolRegistry {
  constructor(
    config: Config,
    private readonly mainRegistryProvider: MainToolRegistryProvider,
    hostTools: readonly AnyDeclarativeTool[],
    schemaOptions: ToolRegistrySchemaOptions = {},
  ) {
    super(config, true, schemaOptions);
    for (const tool of hostTools) {
      this.registerTool(tool);
    }
    this.sortTools();
  }

  private getMainRegistry(): ToolRegistry {
    const registry =
      typeof this.mainRegistryProvider === 'function'
      ? this.mainRegistryProvider()
      : this.mainRegistryProvider;
    if (!registry) {
      throw new Error('Main tool registry is not initialized');
    }
    return registry;
  }

  override getFunctionDeclarations(
    modelId?: string,
    schemaContext?: FileReadRecoverySchemaContext,
  ): FunctionDeclaration[] {
    // Host tools are mounted by the runtime after the SDK/CLI main-tool
    // allowlist has been resolved. Keep normal active/deny filtering, but do
    // not let that main-agent allowlist hide the host-owned surface.
    const hostDeclarations = super.getFunctionDeclarationsFiltered(
      super.getAllKnownTools().map((tool) => tool.name),
      modelId,
      schemaContext,
    );
    const hostNames = new Set(
      hostDeclarations.flatMap((declaration) =>
        declaration.name ? [declaration.name] : [],
      ),
    );
    const mainDeclarations =
      this.getMainRegistry().getFunctionDeclarations(modelId, schemaContext);
    return [
      ...mainDeclarations.filter(
        (declaration) => !hostNames.has(declaration.name ?? ''),
      ),
      ...hostDeclarations,
    ];
  }

  override getTool(name: string): AnyDeclarativeTool | undefined {
    return super.getTool(name) ?? this.getMainRegistry().getTool(name);
  }

  override getKnownTool(name: string): AnyDeclarativeTool | undefined {
    return (
      super.getKnownTool(name) ?? this.getMainRegistry().getKnownTool(name)
    );
  }

  override getAllToolNames(): string[] {
    return [
      ...new Set([
        ...this.getMainRegistry().getAllToolNames(),
        ...super.getAllToolNames(),
      ]),
    ];
  }

  override getAllTools(): AnyDeclarativeTool[] {
    const tools = new Map<string, AnyDeclarativeTool>();
    for (const tool of this.getMainRegistry().getAllTools()) {
      tools.set(tool.name, tool);
    }
    for (const tool of super.getAllTools()) {
      tools.set(tool.name, tool);
    }
    return [...tools.values()];
  }
}
