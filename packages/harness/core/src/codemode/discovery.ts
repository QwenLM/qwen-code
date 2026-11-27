/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { compactToolMatch } from './tool-catalog.js';
import { resolveNamespaceName, type ToolSearchIndex } from './tool-search.js';
import {
  emptyDiscoveryResult,
  type ScriptDiscoveryRequest,
  type ScriptNamespace,
  type ScriptToolDescription,
  type ToolDiscoveryResult,
} from './types.js';

/** searchTools, describeTool({format:"schema"}) and describeNamespace over one admitted tool set. */
export class ScriptToolDiscovery {
  private readonly tools: ReadonlyMap<string, ScriptToolDescription>;
  private readonly namespaces: ReadonlyMap<string, ScriptNamespace>;
  private index?: ToolSearchIndex<ScriptToolDescription>;

  /** `buildIndex` runs on the first search; schema and namespace lookups never need it. */
  constructor(
    tools: readonly ScriptToolDescription[],
    namespaces: readonly ScriptNamespace[],
    private readonly buildIndex: () => ToolSearchIndex<ScriptToolDescription>,
  ) {
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
    this.namespaces = new Map(namespaces.map((entry) => [entry.name, entry]));
  }

  /** `onSearch` receives the ranked entries before they are formatted for the script. */
  discover(
    request: ScriptDiscoveryRequest,
    onSearch?: (matches: readonly ScriptToolDescription[]) => void,
  ): ToolDiscoveryResult {
    if (request.kind === 'tool') {
      const definition = this.tools.get(request.name)?.definition;
      return definition
        ? { name: request.name, ...definition }
        : emptyDiscoveryResult(request);
    }
    if (request.kind === 'namespace') {
      const name = resolveNamespaceName(this.namespaces, request.name);
      return name === undefined ? null : this.namespaces.get(name)!;
    }
    this.index ??= this.buildIndex();
    const matches = this.index.search(request.query, {
      limit: request.limit,
      namespace: request.namespace,
      browseOnEmptyTerms: request.format !== 'compact',
    });
    onSearch?.(matches);
    return request.format === 'compact'
      ? matches.map((tool) => compactToolMatch(tool))
      : matches.map((tool) => tool.name);
  }
}
