/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import { CopyIcon } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import {
  warnClipboardWriteFailure,
  writeClipboardText,
} from '../../utils/clipboard';

/** What the daemon returns for a new share; the secret is shown once. */
export interface AgentShare {
  endpoint: string;
  workspaceId: string;
  callerId: string;
  agentId: string;
  secret: string;
  scope: 'analysis' | 'full';
  expiresAt?: number;
}

export interface AgentShareSummary {
  callerId: string;
  scope: 'analysis' | 'full';
  createdAt: number;
  expiresAt?: number;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The daemon builds the endpoint from the address this page was opened on. */
function isLoopback(endpoint: string): boolean {
  try {
    return LOOPBACK.has(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}

function curlFor(share: AgentShare): string {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'SendMessage',
    params: {
      message: {
        role: 'ROLE_USER',
        messageId: 'hello-1',
        parts: [{ text: 'Hello! What can you help with?' }],
      },
    },
  });
  return [
    `curl -s ${share.endpoint}`,
    `-H 'A2A-Version: 1.0'`,
    `-H 'Authorization: Bearer ${share.secret}'`,
    `-H 'x-qwen-workspace-id: ${share.workspaceId}'`,
    `-H 'x-qwen-caller-id: ${share.callerId}'`,
    `-H 'x-qwen-agent-id: ${share.agentId}'`,
    `-H 'content-type: application/json'`,
    `-d '${body}'`,
  ].join(' ');
}

function Copyable({ label, text }: { label: string; text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 py-1.5 pr-1.5 pl-3">
        <code className="min-w-0 flex-1 truncate font-mono text-xs">
          {text}
        </code>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void writeClipboardText(text).then(
              () => setCopied(true),
              (error: unknown) => warnClipboardWriteFailure(error),
            )
          }
        >
          <CopyIcon aria-hidden="true" />
          {copied ? t('collab.runtime.copied') : t('collab.runtime.copy')}
        </Button>
      </div>
    </div>
  );
}

/**
 * Share one agent with a caller outside this workspace over A2A. The agent
 * keeps running here; the caller gets an endpoint, a token shown once and a
 * one-line test. Each share is its own grant, so revoking one leaves the
 * others working.
 */
export function ShareAgentDialog({
  agentName,
  open,
  onOpenChange,
  onCreate,
  onList,
  onRevoke,
}: {
  agentName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (scope: 'analysis' | 'full') => Promise<AgentShare>;
  onList: () => Promise<AgentShareSummary[]>;
  onRevoke: (callerId: string) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const [scope, setScope] = useState<'analysis' | 'full'>('analysis');
  const [share, setShare] = useState<AgentShare>();
  const [shares, setShares] = useState<AgentShareSummary[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  // Read on open only; the caller's handler identity may change every render.
  const listRef = useRef(onList);
  listRef.current = onList;
  useEffect(() => {
    if (!open) return;
    setShare(undefined);
    setError(undefined);
    void listRef.current().then(setShares, () => setShares([]));
  }, [open]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      setShares(await listRef.current());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* One track as wide as the dialog: long commands and tokens must
          truncate inside it instead of widening the dialog past the screen. */}
      <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {t('collab.share.title', { name: agentName })}
          </DialogTitle>
          <DialogDescription>{t('collab.share.description')}</DialogDescription>
        </DialogHeader>

        {share ? (
          <div className="flex flex-col gap-3">
            <Copyable
              label={t('collab.share.endpoint')}
              text={share.endpoint}
            />
            <Copyable label={t('collab.share.token')} text={share.secret} />
            <Copyable label={t('collab.share.try')} text={curlFor(share)} />
            <p className="text-xs text-muted-foreground">
              {t('collab.share.once')}
            </p>
            {isLoopback(share.endpoint) && (
              <p role="alert" className="text-xs text-destructive">
                {t('collab.share.loopback')}
              </p>
            )}
          </div>
        ) : (
          <div
            role="radiogroup"
            aria-label={t('collab.share.scope')}
            className="flex flex-col gap-2 text-sm"
          >
            {(['analysis', 'full'] as const).map((value) => (
              <label
                key={value}
                className="flex items-start gap-2 rounded-md border border-border p-3"
              >
                <input
                  type="radio"
                  name="share-scope"
                  checked={scope === value}
                  onChange={() => setScope(value)}
                />
                <span>
                  <span className="block font-medium">
                    {t(`collab.share.scope.${value}`)}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t(`collab.share.scope.${value}Hint`)}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}

        {shares.length > 0 && (
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">
              {t('collab.share.active', { count: shares.length })}
            </span>
            {shares.map((entry) => (
              <div
                key={entry.callerId}
                className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-muted"
              >
                <span className="min-w-0 flex-1 truncate">
                  {t(`collab.share.scope.${entry.scope}`)}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {entry.expiresAt
                      ? t('collab.share.until', {
                          date: new Date(entry.expiresAt).toLocaleDateString(),
                        })
                      : ''}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void run(() => onRevoke(entry.callerId))}
                >
                  {t('collab.share.revoke')}
                </Button>
              </div>
            ))}
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          {share ? (
            <Button onClick={() => onOpenChange(false)}>
              {t('collab.runtime.done')}
            </Button>
          ) : (
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => setShare(await onCreate(scope)))
              }
            >
              {t('collab.share.create')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
