/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { CheckCircle2, CopyIcon, LoaderCircle } from 'lucide-react';
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
import { Input } from '../ui/input';
import {
  warnClipboardWriteFailure,
  writeClipboardText,
} from '../../utils/clipboard';

export interface RuntimeSummary {
  id: string;
  kind: 'local' | 'external';
  label: string;
  provider: string;
  providers?: readonly string[];
  status: 'online' | 'offline';
}

export interface JoinToken {
  token: string;
  workspaceId: string;
  expiresAt: number;
}

export interface ConnectExistingInput {
  remoteUrl: string;
  remoteToken: string;
  remoteCwd: string;
  serverUrl: string;
  provider: 'qwen' | 'codex';
  allowHttp: boolean;
}

function onlineIds(runtimes: readonly RuntimeSummary[]): Set<string> {
  return new Set(
    runtimes
      .filter((runtime) => runtime.status === 'online')
      .map((runtime) => runtime.id),
  );
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function joinCommands(address: string, join: JoinToken) {
  const url = new URL(address);
  const base = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  const link = `${base}/join/${encodeURIComponent(join.workspaceId)}/${encodeURIComponent(join.token)}`;
  // A host refuses plain HTTP off loopback unless told the network is trusted.
  const insecure = url.protocol === 'http:' && !LOOPBACK.has(url.hostname);
  const args = `serve --no-web --port 0 --join '${link}'${insecure ? ' --agent-host-allow-http' : ''}`;
  return {
    qwen: `qwen ${args}`,
    npx: `npx -y @qwen-code/qwen-code@latest ${args}`,
    insecure,
  };
}

function CommandLine({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 py-1.5 pr-1.5 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-xs">{text}</code>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          void writeClipboardText(text).then(
            () => setCopied(true),
            (error: unknown) => warnClipboardWriteFailure(error),
          );
        }}
      >
        <CopyIcon aria-hidden="true" />
        {copied ? t('collab.runtime.copied') : t('collab.runtime.copy')}
      </Button>
    </div>
  );
}

/**
 * "Add runtime": hand another machine a one-line command, then wait for it to
 * show up. The dialog notices the new runtime through the same live stream
 * that updates the Runtime tab, so it flips from waiting to connected by
 * itself (the Tailscale/Vercel "add device" pattern).
 */
export function AddRuntimeDialog({
  open,
  onOpenChange,
  serverUrl,
  runtimes,
  onCreateJoinToken,
  onConnectExisting,
  onCreateAgentOn,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The coordinator address this page talks to; the link's default. */
  serverUrl: string;
  runtimes: readonly RuntimeSummary[];
  onCreateJoinToken: () => Promise<JoinToken>;
  onConnectExisting?: (input: ConnectExistingInput) => Promise<boolean>;
  onCreateAgentOn?: (runtimeId: string) => void;
}) {
  const { t } = useI18n();
  const [method, setMethod] = useState<'command' | 'existing'>('command');
  const [address, setAddress] = useState(serverUrl);
  const [join, setJoin] = useState<JoinToken>();
  // Runtimes online when we started waiting; one that is online now and was
  // not is the one that joined. Online, not present: a machine that joined
  // before reuses its saved identity and comes back under the same id.
  const [watch, setWatch] = useState<{
    at: number;
    known: ReadonlySet<string>;
  }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const connected = useMemo(
    () =>
      watch
        ? runtimes.find(
            (runtime) =>
              runtime.kind === 'external' &&
              runtime.status === 'online' &&
              !watch.known.has(runtime.id),
          )
        : undefined,
    [watch, runtimes],
  );
  const waiting = open && watch !== undefined && !connected;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [waiting]);

  const commands = useMemo(() => {
    if (!join) return undefined;
    try {
      return joinCommands(address, join);
    } catch {
      return undefined;
    }
  }, [address, join]);

  const generate = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (!safeHost(address)) throw new Error(t('collab.runtime.badAddress'));
      setJoin(await onCreateJoinToken());
      setWatch({
        at: Date.now(),
        known: onlineIds(runtimes),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const submitExisting = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!onConnectExisting) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError(undefined);
    const known = onlineIds(runtimes);
    try {
      const ok = await onConnectExisting({
        remoteUrl: String(data.get('remoteUrl')),
        remoteToken: String(data.get('remoteToken')),
        remoteCwd: String(data.get('remoteCwd')),
        serverUrl: address,
        provider: data.get('provider') === 'codex' ? 'codex' : 'qwen',
        allowHttp: data.get('allowHttp') === 'on',
      });
      if (ok) setWatch({ at: Date.now(), known });
    } finally {
      setBusy(false);
    }
  };

  const minutesLeft = join
    ? Math.max(0, Math.ceil((join.expiresAt - now) / 60_000))
    : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* One track as wide as the dialog: long commands and tokens must
          truncate inside it instead of widening the dialog past the screen. */}
      <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('collab.runtime.addTitle')}</DialogTitle>
          <DialogDescription>
            {t('collab.runtime.addDescription')}
          </DialogDescription>
        </DialogHeader>

        {connected ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3 rounded-md border border-[var(--status-done-fg)]/30 bg-[var(--status-done-bg)] p-3">
              <CheckCircle2
                aria-hidden="true"
                className="size-5 shrink-0 text-[var(--status-done-fg)]"
              />
              <div className="min-w-0">
                <p className="font-medium">
                  {t('collab.runtime.connected', { name: connected.label })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('collab.runtime.offers', {
                    programs: (connected.providers?.length
                      ? connected.providers
                      : [connected.provider]
                    ).join(', '),
                  })}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div
              role="tablist"
              className="flex gap-4 border-b border-border text-sm"
            >
              {(['command', 'existing'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={method === value}
                  onClick={() => setMethod(value)}
                  className={`-mb-px border-b-2 pb-2 ${
                    method === value
                      ? 'border-foreground font-medium'
                      : 'border-transparent text-muted-foreground'
                  }`}
                >
                  {value === 'command'
                    ? t('collab.runtime.methodCommand')
                    : t('collab.runtime.methodExisting')}
                </button>
              ))}
            </div>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">{t('collab.runtime.address')}</span>
              <Input
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                disabled={join !== undefined}
              />
              <span className="text-xs text-muted-foreground">
                {LOOPBACK.has(safeHost(address))
                  ? t('collab.runtime.loopbackHint')
                  : t('collab.runtime.addressHint')}
              </span>
            </label>

            {method === 'command' ? (
              join && commands ? (
                <div className="flex flex-col gap-3 text-sm">
                  <p className="font-medium">{t('collab.runtime.runThis')}</p>
                  <CommandLine text={commands.qwen} />
                  <p className="text-xs text-muted-foreground">
                    {t('collab.runtime.noQwen')}
                  </p>
                  <CommandLine text={commands.npx} />
                  <p className="text-xs text-muted-foreground">
                    {t('collab.runtime.expires', { minutes: minutesLeft })}
                    {commands.insecure && ` ${t('collab.runtime.httpHint')}`}
                  </p>
                  <div className="flex items-center gap-3 rounded-md border border-dashed border-border p-3">
                    <LoaderCircle
                      aria-hidden="true"
                      className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
                    />
                    <div>
                      <p className="font-medium">
                        {t('collab.runtime.waiting')}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t('collab.runtime.waitingFor', {
                          seconds: Math.max(
                            0,
                            Math.floor((now - (watch?.at ?? now)) / 1_000),
                          ),
                        })}
                      </p>
                    </div>
                  </div>
                </div>
              ) : null
            ) : (
              <form
                id="connect-existing-runtime"
                className="flex flex-col gap-3 text-sm"
                onSubmit={(event) => void submitExisting(event)}
              >
                <label className="flex flex-col gap-1.5">
                  {t('collab.runtime.remoteUrl')}
                  <Input
                    name="remoteUrl"
                    type="url"
                    required
                    placeholder="http://192.168.1.20:4170"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  {t('collab.runtime.remoteToken')}
                  <Input
                    name="remoteToken"
                    type="password"
                    autoComplete="off"
                    required
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  {t('collab.runtime.remoteCwd')}
                  <Input
                    name="remoteCwd"
                    required
                    placeholder="/home/me/project"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  {t('collab.runtime.program')}
                  <select
                    name="provider"
                    className="h-9 rounded-md border border-input bg-transparent px-2"
                  >
                    <option value="qwen">Qwen Code</option>
                    <option value="codex">Codex</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" name="allowHttp" />
                  {t('collab.runtime.allowHttp')}
                </label>
              </form>
            )}
          </>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          {connected ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('collab.runtime.done')}
              </Button>
              {onCreateAgentOn && (
                <Button onClick={() => onCreateAgentOn(connected.id)}>
                  {t('collab.runtime.createAgentOn', { name: connected.label })}
                </Button>
              )}
            </>
          ) : method === 'command' ? (
            join ? (
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('collab.runtime.closeKeepLink')}
              </Button>
            ) : (
              <Button disabled={busy} onClick={() => void generate()}>
                {t('collab.runtime.generate')}
              </Button>
            )
          ) : (
            <Button
              type="submit"
              form="connect-existing-runtime"
              disabled={busy || !onConnectExisting}
            >
              {t('collab.runtime.connect')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function safeHost(address: string): string {
  try {
    return new URL(address).hostname;
  } catch {
    return '';
  }
}
