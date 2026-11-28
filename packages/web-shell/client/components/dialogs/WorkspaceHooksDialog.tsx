/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DaemonHookConfig,
  DaemonWorkspaceHooksStatus,
} from '@qwen-code/sdk/daemon';
import {
  useWorkspace,
  useWorkspaceEventSignals,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { Alert, AlertDescription } from '../ui/alert';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';

function describeHookConfig(config: DaemonHookConfig): string {
  if ('command' in config && typeof config.command === 'string') {
    return config.command;
  }
  if ('url' in config && typeof config.url === 'string') {
    return config.url;
  }
  if ('prompt' in config && typeof config.prompt === 'string') {
    return config.prompt;
  }
  return config.name || config.description || config.type;
}

export interface WorkspaceHooksDialogProps {
  workspaceCwd: string;
}

export function WorkspaceHooksDialog({
  workspaceCwd,
}: WorkspaceHooksDialogProps) {
  const { t } = useI18n();
  const workspace = useWorkspace();
  const signals = useWorkspaceEventSignals();
  const [status, setStatus] = useState<DaemonWorkspaceHooksStatus>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [decisionError, setDecisionError] = useState(false);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await workspace.client
        .workspaceByCwd(workspaceCwd)
        .workspaceHooks();
      if (requestId === requestIdRef.current) {
        setStatus(next);
      }
    } catch (err) {
      if (requestId === requestIdRef.current) {
        setStatus(undefined);
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [workspace.client, workspaceCwd]);

  useEffect(() => {
    void load();
  }, [load, signals?.settingsVersion]);

  const decide = useCallback(
    async (decision: 'approve' | 'reject') => {
      if (decisionBusy) return;
      setDecisionBusy(true);
      setDecisionError(false);
      try {
        await workspace.client
          .workspaceByCwd(workspaceCwd)
          .approveWorkspaceHooks(decision, status?.pendingApprovalHash);
      } catch {
        setDecisionError(true);
      } finally {
        await load();
        setDecisionBusy(false);
      }
    },
    [
      decisionBusy,
      load,
      status?.pendingApprovalHash,
      workspace.client,
      workspaceCwd,
    ],
  );

  if (loading && !status) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Spinner />
        <span>{t('workspaceHooks.loading')}</span>
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  const hooks = status?.hooks ?? [];
  const pendingLines = status?.pendingApprovalHooks ?? [];

  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate font-mono" title={workspaceCwd}>
          {workspaceCwd}
        </span>
        {status?.disabled ? (
          <Badge variant="outline">{t('workspaceHooks.disabled')}</Badge>
        ) : null}
      </div>

      {status?.pendingApproval ? (
        <div
          className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-3"
          data-testid="workspace-hooks-pending-approval"
        >
          <div className="font-medium text-foreground">
            {t('hooksApproval.title')}
          </div>
          {pendingLines.length > 0 ? (
            <pre className="overflow-x-auto rounded bg-background p-2 font-mono text-xs">
              {pendingLines.join('\n')}
            </pre>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {t('hooksApproval.scopeNote')}
          </p>
          {decisionError ? (
            <p className="text-xs text-destructive">
              {t('hooksApproval.failed')}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={decisionBusy}
              onClick={() => void decide('reject')}
            >
              {t('hooksApproval.reject')}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={decisionBusy}
              onClick={() => void decide('approve')}
            >
              {t('hooksApproval.approve')}
            </Button>
          </div>
        </div>
      ) : null}

      {hooks.length === 0 ? (
        <p className="py-4 text-center text-muted-foreground">
          {t('workspaceHooks.empty')}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {hooks.map((hook, index) => (
            <div
              key={`${hook.eventName}-${hook.hookId ?? index}`}
              className="flex flex-col gap-1 rounded-md border border-border p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">
                    {hook.eventName}
                  </span>
                  {hook.matcher ? (
                    <Badge variant="secondary" className="font-mono text-xs">
                      {hook.matcher}
                    </Badge>
                  ) : null}
                  <Badge variant="outline" className="text-xs">
                    {hook.source}
                  </Badge>
                </div>
                <Badge
                  variant={hook.enabled ? 'secondary' : 'outline'}
                  className="text-xs"
                >
                  {hook.enabled
                    ? t('workspaceHooks.enabled')
                    : (hook.disabledReason ?? t('workspaceHooks.disabled'))}
                </Badge>
              </div>
              <div className="truncate font-mono text-xs text-muted-foreground">
                {describeHookConfig(hook.config)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
