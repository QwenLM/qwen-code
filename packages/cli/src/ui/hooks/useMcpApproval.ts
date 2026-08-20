/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useEffect } from 'react';
import type {
  Config,
  MCPServerConfig,
  McpServerScope,
} from '@qwen-code/qwen-code-core';
import { ApprovalMode, isGatedMcpScope } from '@qwen-code/qwen-code-core';
import { loadMcpApprovals } from '../../config/mcpApprovals.js';
import { McpApprovalChoice } from '../components/mcp/MCPServerApprovalDialog.js';
import { appEvents, AppEvent } from '../../utils/events.js';

export interface PendingMcpServer {
  name: string;
  config: MCPServerConfig;
  /** One-line transport/config summary for display. */
  summary: string;
  /** Human-readable origin of the config (e.g. `.mcp.json`), for the dialog. */
  source: string;
}

/** Where a gated server's config came from, for display in the approval dialog. */
function sourceLabel(scope: McpServerScope | undefined): string {
  switch (scope) {
    case 'workspace':
      return '.qwen/settings.json';
    case 'project':
    default:
      return '.mcp.json';
  }
}

function summarize(config: MCPServerConfig): string {
  let summary: string;
  if (config.httpUrl) {
    summary = `${config.httpUrl} (http)`;
  } else if (config.url) {
    summary = `${config.url} (sse)`;
  } else if (config.command) {
    summary =
      `${config.command} ${config.args?.join(' ') ?? ''} (stdio)`.replace(
        /\s+\(/,
        ' (',
      );
  } else {
    summary = '(unknown transport)';
  }

  const details: string[] = [];
  if (config.env && Object.keys(config.env).length > 0) {
    details.push(`env: ${Object.keys(config.env).join(', ')}`);
  }
  if (config.headers && Object.keys(config.headers).length > 0) {
    details.push(`headers: ${Object.keys(config.headers).join(', ')}`);
  }
  return details.length > 0 ? `${summary} [${details.join('; ')}]` : summary;
}

/**
 * Drives the interactive startup approval dialog for gated MCP servers — project
 * `.mcp.json` and workspace `.qwen/settings.json` (issue #4615). On mount it
 * computes the queue of `pending` gated servers; the dialog asks about them one
 * at a time. Approving persists the decision (bound to the config hash), un-gates
 * the server for this session, and re-runs discovery so it connects; rejecting
 * persists a `rejected` decision and leaves it disconnected.
 *
 * Non-interactive sessions never render this hook. They still receive the
 * loader's pending set so discovery can skip gated servers without prompting.
 */
export const useMcpApproval = (config: Config) => {
  const [queue, setQueue] = useState<PendingMcpServer[]>([]);

  // Recompute the pending-approval queue from the authoritative sources (the
  // live server map + persisted approvals). Reused for both the initial mount
  // and mid-session recomputes triggered by a settings hot-reload.
  const computePending = useCallback((): PendingMcpServer[] => {
    if (config.getApprovalMode() === ApprovalMode.YOLO) return [];
    const servers = config.getMcpServers() ?? {};
    const approvals = loadMcpApprovals();
    const root = config.getWorkingDir();
    return Object.entries(servers)
      .filter(([, c]) => isGatedMcpScope(c.scope))
      .filter(([name, c]) => approvals.getState(root, name, c) === 'pending')
      .map(([name, c]) => ({
        name,
        config: c,
        summary: summarize(c),
        source: sourceLabel(c.scope),
      }));
  }, [config]);

  // Initial queue at startup.
  useEffect(() => {
    setQueue(computePending());
  }, [computePending]);

  // A hot-reload may push a gated server into `pending` mid-session (e.g. an
  // edit invalidated its hash-bound approval). Re-evaluate so the dialog pops
  // immediately instead of only at startup. Servers the user has since
  // approved/rejected are filtered out by `computePending` reading the
  // persisted file, so this never re-prompts a settled decision. See #4615.
  useEffect(() => {
    const onPendingChanged = () => {
      setQueue(computePending());
    };
    appEvents.on(AppEvent.McpPendingApprovalChanged, onPendingChanged);
    return () => {
      appEvents.off(AppEvent.McpPendingApprovalChanged, onPendingChanged);
    };
  }, [computePending]);

  const reconnect = useCallback(
    (name: string) => {
      config.approveMcpServerForSession(name);
      const registry = config.getToolRegistry();
      void registry
        ?.discoverToolsForServer?.(name)
        ?.catch?.((error: unknown) => {
          if (process.env['DEBUG']) {
            // eslint-disable-next-line no-console
            console.error(`MCP reconnect failed for ${name}:`, error);
          }
        });
    },
    [config],
  );

  const handleMcpApprovalSelect = useCallback(
    async (choice: McpApprovalChoice) => {
      const approvals = loadMcpApprovals();
      const root = config.getWorkingDir();
      const current = queue[0];
      if (!current) {
        return;
      }
      if (choice === McpApprovalChoice.APPROVE_ALL) {
        for (const server of queue) {
          await approvals.setState(
            root,
            server.name,
            server.config,
            'approved',
          );
          reconnect(server.name);
        }
        setQueue([]);
        return;
      }
      if (choice === McpApprovalChoice.APPROVE) {
        await approvals.setState(
          root,
          current.name,
          current.config,
          'approved',
        );
        reconnect(current.name);
      } else {
        await approvals.setState(
          root,
          current.name,
          current.config,
          'rejected',
        );
      }
      setQueue((q) => q.slice(1));
    },
    [config, queue, reconnect],
  );

  return {
    isMcpApprovalDialogOpen: queue.length > 0,
    currentMcpApproval: queue[0],
    pendingMcpApprovals: queue,
    mcpApprovalRemaining: Math.max(0, queue.length - 1),
    handleMcpApprovalSelect,
  };
};
