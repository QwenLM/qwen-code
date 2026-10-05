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
  replacementHostId?: string;
}

export interface ConnectExistingInput {
  remoteUrl: string;
  remoteToken: string;
  remoteCwd: string;
  serverUrl: string;
  provider: 'qwen';
  allowHttp: boolean;
}

export function findReplacementRuntime(
  runtimes: readonly RuntimeSummary[],
  knownIds: ReadonlySet<string>,
  supersededHostId: string,
  replacementHostId?: string,
): RuntimeSummary | undefined {
  if (runtimes.some((runtime) => runtime.id === supersededHostId)) {
    return undefined;
  }
  return runtimes.find(
    (runtime) =>
      runtime.kind === 'external' &&
      runtime.status === 'online' &&
      (replacementHostId
        ? runtime.id === replacementHostId
        : !knownIds.has(runtime.id)),
  );
}

function onlineIds(runtimes: readonly RuntimeSummary[]): Set<string> {
  return new Set(
    runtimes
      .filter((runtime) => runtime.status === 'online')
      .map((runtime) => runtime.id),
  );
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function coordinatorUrl(address: string): URL {
  const url = new URL(address);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Invalid coordinator address.');
  }
  return url;
}

export function joinCommands(address: string, join: JoinToken) {
  const url = coordinatorUrl(address);
  const base = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  const link = `${base}/join/${encodeURIComponent(join.workspaceId)}`;
  // A host refuses plain HTTP off loopback unless told the network is trusted.
  const insecure = url.protocol === 'http:' && !LOOPBACK.has(url.hostname);
  const enrollment = `QWEN_AGENT_HOST_ENROLLMENT_TOKEN=${shellQuote(join.token)}`;
  const args = `serve --no-web --port 0 --join ${shellQuote(link)}${insecure ? ' --agent-host-allow-http' : ''}`;
  return {
    qwen: `${enrollment} qwen ${args}`,
    npx: `${enrollment} npx -y @qwen-code/qwen-code@latest ${args}`,
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
  replacementTarget,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The coordinator address this page talks to; the link's default. */
  serverUrl: string;
  runtimes: readonly RuntimeSummary[];
  onCreateJoinToken: (supersedesHostId?: string) => Promise<JoinToken>;
  onConnectExisting?: (input: ConnectExistingInput) => Promise<boolean>;
  onCreateAgentOn?: (runtimeId: string) => void;
  replacementTarget?: RuntimeSummary;
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
  const replacementHostId = replacementTarget?.id;

  const connected = useMemo(() => {
    if (!watch) return undefined;
    if (replacementHostId) {
      return findReplacementRuntime(
        runtimes,
        watch.known,
        replacementHostId,
        join?.replacementHostId,
      );
    }
    return runtimes.find(
      (runtime) =>
        runtime.kind === 'external' &&
        runtime.status === 'online' &&
        !watch.known.has(runtime.id),
    );
  }, [replacementHostId, runtimes, watch, join?.replacementHostId]);
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
      setJoin(await onCreateJoinToken(replacementHostId));
      setWatch({
        at: Date.now(),
        known: replacementHostId
          ? new Set(runtimes.map((runtime) => runtime.id))
          : onlineIds(runtimes),
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
        provider: 'qwen',
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
  // An expired link is no use to copy; offer a new one instead.
  const live = join && minutesLeft > 0 ? join : undefined;
  // Once a machine has joined, the next opening starts over, so a second
  // one can be added.
  const close = (next: boolean) => {
    if (!next && connected) {
      setJoin(undefined);
      setWatch(undefined);
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      {/* One track as wide as the dialog: long commands and tokens must
          truncate inside it instead of widening the dialog past the screen. */}
      <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {replacementTarget
              ? t('collab.runtime.replaceTitle', {
                  name: replacementTarget.label,
                })
              : t('collab.runtime.addTitle')}
          </DialogTitle>
          <DialogDescription>
            {replacementTarget
              ? t('collab.runtime.replaceDescription', {
                  name: replacementTarget.label,
                })
              : t('collab.runtime.addDescription')}
          </DialogDescription>
        </DialogHeader>

        {replacementTarget ? (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-muted-foreground">
            {t('collab.runtime.replaceEffects')}
          </p>
        ) : null}

        {!connected && replacementTarget && join?.replacementHostId ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('collab.runtime.replaceRecovery', {
              name: replacementTarget.label,
              id: replacementTarget.id,
            })}
          </p>
        ) : null}

        {connected ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3 rounded-md border border-[var(--status-done-fg)]/30 bg-[var(--status-done-bg)] p-3">
              <CheckCircle2
                aria-hidden="true"
                className="size-5 shrink-0 text-[var(--status-done-fg)]"
              />
              <div className="min-w-0">
                <p className="font-medium">
                  {replacementTarget
                    ? t('collab.runtime.replaced', {
                        oldName: replacementTarget.label,
                        name: connected.label,
                      })
                    : t('collab.runtime.connected', {
                        name: connected.label,
                      })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('collab.runtime.offers', {
                    programs: (connected.providers?.length
                      ? connected.providers
                      : [connected.provider]
                    ).join(', '),
                  })}
                </p>
                {replacementTarget ? (
                  <p className="text-xs text-muted-foreground">
                    {t('collab.runtime.replaceCompleted')}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <>
            {replacementTarget ? null : (
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
            )}

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

            {replacementTarget || method === 'command' ? (
              live && commands ? (
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
              <Button variant="outline" onClick={() => close(false)}>
                {t('collab.runtime.done')}
              </Button>
              {onCreateAgentOn && (
                <Button
                  onClick={() => {
                    close(false);
                    onCreateAgentOn(connected.id);
                  }}
                >
                  {t('collab.runtime.createAgentOn', { name: connected.label })}
                </Button>
              )}
            </>
          ) : replacementTarget || method === 'command' ? (
            live ? (
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('collab.runtime.closeKeepLink')}
              </Button>
            ) : (
              <Button disabled={busy} onClick={() => void generate()}>
                {t(
                  replacementTarget && join
                    ? 'collab.runtime.refreshReplacement'
                    : 'collab.runtime.generate',
                )}
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
    return coordinatorUrl(address).hostname;
  } catch {
    return '';
  }
}
