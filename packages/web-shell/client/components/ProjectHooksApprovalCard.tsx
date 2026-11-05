import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DaemonWorkspaceHooksStatus } from '@qwen-code/sdk/daemon';
import {
  useOptionalWorkspace,
  useWorkspaceEventSignals,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useDaemonAvailability } from '../daemon/availability-context.js';
import type { PermissionRequest } from '../adapters/types';
import { useI18n } from '../i18n';
import { ToolApproval } from './messages/ToolApproval';

const POLL_INTERVAL_MS = 30_000;

/**
 * The Web Shell counterpart of the TUI project-hooks approval dialog: when
 * the workspace's `.qwen/settings.json` declares hooks that have not been
 * approved, they stay withheld and the shared ToolApproval card asks for an
 * explicit decision, in the same slot and style as tool approvals.
 * Deliberately not a session permission prompt — automation clients
 * auto-answer those; a trust decision must be a user act.
 */
export function ProjectHooksApprovalCard({
  onActiveChange,
}: {
  /** Reports whether the card owns the approval slot, so the host treats
   * the composer as dormant exactly like a tool approval overlay. */
  onActiveChange?: (active: boolean) => void;
} = {}) {
  const workspace = useOptionalWorkspace();
  const available = useDaemonAvailability() === 'available';
  const signals = useWorkspaceEventSignals();
  const { t } = useI18n();
  const [status, setStatus] = useState<DaemonWorkspaceHooksStatus>();
  const [busy, setBusy] = useState(false);
  const [dismissedHash, setDismissedHash] = useState<string>();
  const requestIdRef = useRef(0);
  const client = workspace?.client;
  const workspaceCwd = workspace?.workspaceCwd;
  const settingsVersion = signals?.settingsVersion;

  const refresh = useCallback(async () => {
    if (!client || !available) return;
    const requestId = ++requestIdRef.current;
    try {
      const handle = workspaceCwd
        ? client.workspaceByCwd(workspaceCwd)
        : client;
      const next = await handle.workspaceHooks();
      if (requestId === requestIdRef.current) setStatus(next);
    } catch {
      // Older daemons lack the route; the card stays hidden.
      if (requestId === requestIdRef.current) setStatus(undefined);
    }
  }, [client, workspaceCwd, available]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // One read per mount / workspace / settings change. Keyed on identity,
  // not the refresh callback, so a decision-driven re-render never refetches.
  useEffect(() => {
    setStatus(undefined);
    void refreshRef.current();
  }, [client, workspaceCwd, available, settingsVersion]);

  // Poll only while a decision is pending. Once resolved (or on daemons
  // without hooks), no background reads: workspace metadata stays quiet
  // until a settings event or remount changes the answer.
  useEffect(() => {
    if (!client || !available || !status?.pendingApproval) return;
    const timer = setInterval(
      () => void refreshRef.current(),
      POLL_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, [client, available, status?.pendingApproval]);

  const decide = useCallback(
    async (decision: 'approve' | 'reject') => {
      if (!client || busy) return;
      setBusy(true);
      try {
        const handle = workspaceCwd
          ? client.workspaceByCwd(workspaceCwd)
          : client;
        // Echo the hash of the block this card rendered: the decision binds
        // to that exact block, and a workspace file that changed since the
        // render stays pending instead of being approved unseen.
        await handle.approveWorkspaceHooks(
          decision,
          status?.pendingApprovalHash,
        );
      } finally {
        await refresh();
        setBusy(false);
      }
    },
    [client, workspaceCwd, busy, refresh, status?.pendingApprovalHash],
  );

  const request = useMemo<PermissionRequest | undefined>(() => {
    if (!status?.pendingApproval) return undefined;
    // Escape defers the decision (TUI semantics): hide until the block
    // changes, never record a rejection for a habitual keypress.
    if (
      status.pendingApprovalHash !== undefined &&
      status.pendingApprovalHash === dismissedHash
    ) {
      return undefined;
    }
    const lines = status.pendingApprovalHooks ?? [];
    return {
      id: 'project-hooks-approval',
      toolName: 'project_hooks',
      contentIsInput: true,
      content: [
        {
          type: 'text',
          text: [
            ...lines,
            ...(lines.length > 0 ? [''] : []),
            t('hooksApproval.scopeNote'),
          ].join('\n'),
        },
      ],
      // Distinct ids without the generic i18n-keyed option ids so the shared
      // card keeps these decision-specific labels. Both are *_once kinds so
      // the shared safe-default logic pre-selects the reject side: a stray
      // Enter on this security gate must never grant hook execution. The
      // decision itself is still persistent and hash-bound.
      options: [
        {
          id: 'hooks_approve',
          label: t('hooksApproval.approve'),
          kind: 'allow_once',
        },
        {
          id: 'hooks_reject',
          label: t('hooksApproval.reject'),
          kind: 'reject_once',
        },
      ],
    };
  }, [status, t, dismissedHash]);

  const active = request !== undefined;
  useEffect(() => {
    onActiveChange?.(active);
    return () => onActiveChange?.(false);
  }, [active, onActiveChange]);

  if (!request) return null;
  return (
    <div data-testid="project-hooks-approval-card">
      <ToolApproval
        request={request}
        variant="floating"
        disabled={busy}
        escapeDismisses
        onDismiss={() => setDismissedHash(status?.pendingApprovalHash)}
        onConfirm={(_id, selectedOption) =>
          decide(selectedOption === 'hooks_approve' ? 'approve' : 'reject')
        }
      />
    </div>
  );
}
