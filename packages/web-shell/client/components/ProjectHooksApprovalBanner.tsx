import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonWorkspaceHooksStatus } from '@qwen-code/sdk/daemon';
import {
  useOptionalWorkspace,
  useWorkspaceEventSignals,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useDaemonAvailability } from '../daemon/availability-context.js';
import { useI18n } from '../i18n';
import { Alert, AlertDescription } from './ui/alert';
import { Button } from './ui/button';

const POLL_INTERVAL_MS = 30_000;

/**
 * The Web Shell counterpart of the TUI project-hooks approval dialog: when
 * the workspace's `.qwen/settings.json` declares hooks that have not been
 * approved, they stay withheld and this banner asks for an explicit
 * decision. Deliberately not a session permission prompt — automation
 * clients auto-answer those; a trust decision must be a user act.
 */
export function ProjectHooksApprovalBanner() {
  const workspace = useOptionalWorkspace();
  const available = useDaemonAvailability() === 'available';
  const signals = useWorkspaceEventSignals();
  const { t } = useI18n();
  const [status, setStatus] = useState<DaemonWorkspaceHooksStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
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
      // Older daemons lack the route; the banner stays hidden.
      if (requestId === requestIdRef.current) setStatus(undefined);
    }
  }, [client, workspaceCwd, available]);

  useEffect(() => {
    setStatus(undefined);
    void refresh();
    if (!client || !available) return;
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [client, available, refresh, settingsVersion]);

  const decide = useCallback(
    async (decision: 'approve' | 'reject') => {
      if (!client || busy) return;
      setBusy(true);
      setError(undefined);
      try {
        const handle = workspaceCwd
          ? client.workspaceByCwd(workspaceCwd)
          : client;
        await handle.approveWorkspaceHooks(decision);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [client, workspaceCwd, busy, refresh],
  );

  if (!status?.pendingApproval) return null;
  const lines = status.pendingApprovalHooks ?? [];
  return (
    <Alert
      className="rounded-none border-x-0 border-t-0"
      data-testid="project-hooks-approval-banner"
      role="alertdialog"
      aria-label={t('hooksApproval.title')}
    >
      <AlertDescription className="flex flex-col gap-2">
        <span className="font-medium">{t('hooksApproval.title')}</span>
        <span>{t('hooksApproval.description')}</span>
        {lines.length > 0 && (
          <pre
            className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs"
            data-testid="project-hooks-approval-lines"
          >
            {lines.join('\n')}
          </pre>
        )}
        <span className="text-xs text-muted-foreground">
          {t('hooksApproval.scopeNote')}
        </span>
        {error && (
          <span className="text-xs text-destructive" role="alert">
            {error}
          </span>
        )}
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={busy}
            data-testid="project-hooks-approve"
            onClick={() => void decide('approve')}
          >
            {t('hooksApproval.approve')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            data-testid="project-hooks-reject"
            onClick={() => void decide('reject')}
          >
            {t('hooksApproval.reject')}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
