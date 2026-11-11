/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { CheckCircle2, CopyIcon, LoaderCircle } from 'lucide-react';
import { isDaemonUnavailableError } from '../../daemon/availability';
import { useI18n } from '../../i18n';
import { programLabel, runtimePrograms } from './agents-view-logic';
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
  /** Program ids the runtime reported it can run. */
  programs?: readonly string[];
  status: 'online' | 'offline';
  /** The workspace it serves, on its own machine. */
  workspaceCwd?: string;
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
  allowHttp: boolean;
}

/** `POST /hosts/connect`: this daemon joins another coordinator as a runtime. */
export interface JoinCoordinatorInput {
  serverUrl: string;
  workspaceId: string;
  enrollmentToken: string;
  allowHttp: boolean;
}

const JOIN_SEGMENT = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * Reads the link a coordinator shows under Runtime › Add runtime,
 * `<coordinator URL>/join/<workspace id>`. Same rules as `parseJoinLink` in
 * `packages/cli/src/serve/agent-host-join.ts` (keep the two in step); returns
 * undefined instead of throwing so a form can validate as the user types.
 */
export function parseJoinLink(
  link: string,
): { serverUrl: string; workspaceId: string } | undefined {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return undefined;
  }
  const marker = url.pathname.lastIndexOf('/join/');
  const [workspaceId, ...rest] =
    marker >= 0 ? url.pathname.slice(marker + '/join/'.length).split('/') : [];
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !workspaceId ||
    rest.some(Boolean) ||
    !JOIN_SEGMENT.test(workspaceId)
  ) {
    return undefined;
  }
  const base = url.pathname.slice(0, marker).replace(/\/+$/, '');
  return { serverUrl: `${url.origin}${base}`, workspaceId };
}

/**
 * The terminal equivalent of "Join a coordinator": `qwen agents join <link>`
 * asks the running local `qwen serve` to join with the same link (it calls
 * that daemon's `/hosts/connect`, exactly as this dialog does). The token
 * rides in the environment, never in argv.
 */
export function joinCoordinatorCommand(
  link: string,
  token: string,
  allowHttp: boolean,
): string {
  return `QWEN_AGENT_HOST_ENROLLMENT_TOKEN=${shellQuote(token || '<token>')} qwen agents join ${shellQuote(link.trim())}${allowHttp ? ' --allow-http' : ''}`;
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

/**
 * A wait for a computer to show up. `known`: runtimes online when it
 * started; one that is online now and was not is new. Online, not present:
 * a machine that joined before reuses its saved identity and comes back
 * under the same id. It waits for the computer the join command on screen
 * is for, for the remote the address-and-token form connected (`remote`),
 * or for both, when a join command is created before that remote shows up.
 * A remote connect drops the join command (see `submitExisting`), so one
 * still on screen was created after it.
 */
interface RuntimeWatch {
  at: number;
  known: ReadonlySet<string>;
  /**
   * `workspaceCwd`: the workspace the remote answered from, which tells it
   * apart from other computers that show up; without it (an older daemon),
   * the first new runtime is taken for it. `mayBeOnline`: a computer online
   * when it connected already served that workspace, so the remote may be
   * that one, back under its saved id, and never show up as new.
   */
  remote?: { workspaceCwd?: string; mayBeOnline?: true };
}

/** Whether `watch` waits for a remote it can tell apart, still to show up. */
function awaitsRemote(watch: RuntimeWatch | undefined): boolean {
  return watch?.remote?.workspaceCwd !== undefined && !watch.remote.mayBeOnline;
}

/** Whether `runtime`, new during `watch`, is the remote it waits for. */
function isWatchedRemote(
  watch: RuntimeWatch,
  runtime: RuntimeSummary,
): boolean {
  return (
    watch.remote !== undefined &&
    (watch.remote.workspaceCwd === undefined ||
      runtime.workspaceCwd === watch.remote.workspaceCwd)
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

/**
 * What the Host answers for a join whose token the coordinator refused
 * (invalid, expired, spent by another join, or turned down): sent again as
 * it is, it would be refused again.
 */
const REFUSED_JOIN_TOKEN_ERRORS: ReadonlySet<string> = new Set([
  'Invalid or expired Agent Host enrollment token.',
  'Agent Host enrollment refused.',
]);

function isRefusedJoinToken(error: unknown): boolean {
  return error instanceof Error && REFUSED_JOIN_TOKEN_ERRORS.has(error.message);
}

/**
 * Whether this computer's daemon refuses a coordinator address unless HTTP
 * is allowed, as its `hosts/connect` route checks it: plain HTTP off
 * loopback, where any 127.x address counts as loopback.
 */
function refusesPlainHttp(serverUrl: string): boolean {
  const { protocol, hostname } = new URL(serverUrl);
  return (
    protocol === 'http:' &&
    !LOOPBACK.has(hostname) &&
    !/^127(\.\d{1,3}){3}$/.test(hostname)
  );
}

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
 * A join that went through, as the dialog sees it: whether the computer that
 * joined saved the connection. A `saveError` means it will not reconnect
 * after a restart or a workspace reload. `recorded: false` means the
 * credential did not record this join's token, so a rerun of it would be
 * refused and the notice must not advise one. `workspaceCwd`, from a remote
 * connect: the workspace the remote answered from, which its runtime
 * reports too. `false` is a connect that failed and was already reported
 * elsewhere; a failed join throws instead.
 */
export type RuntimeJoinOutcome =
  | false
  | { saveError?: string; workspaceCwd?: string; recorded?: boolean };

/**
 * Reads a `hosts/connect` answer, which `hosts/remote-connect` passes on. An
 * older daemon sends no `saved` field; it always claimed the save. Nor
 * `recorded`; without it, the notice keeps its remedy wording.
 */
export function joinOutcome(answer: unknown): {
  saveError?: string;
  recorded?: boolean;
} {
  if (
    typeof answer !== 'object' ||
    answer === null ||
    (answer as { saved?: unknown }).saved !== false
  ) {
    return {};
  }
  const detail = (answer as { saveError?: unknown }).saveError;
  return {
    saveError: typeof detail === 'string' ? detail : '',
    ...((answer as { recorded?: unknown }).recorded === false
      ? { recorded: false }
      : {}),
  };
}

/**
 * The dialog's "I have its address and token" callback over `run`, which
 * reports a failure itself and resolves false for it.
 */
export function connectExistingWith(
  run: (action: () => Promise<unknown>) => Promise<boolean>,
  connect: (input: ConnectExistingInput) => Promise<unknown>,
  onBusy?: (busy: boolean) => void,
): (input: ConnectExistingInput) => Promise<RuntimeJoinOutcome> {
  return async (input) => {
    let answer: unknown;
    // Like a join, see `joinCoordinatorWith`: its result, and the remote's
    // notice, would be lost with the dialog.
    onBusy?.(true);
    try {
      const ok = await run(async () => {
        answer = await connect(input);
        return answer;
      });
      const workspaceCwd = (
        answer as { workspaceCwd?: unknown } | null | undefined
      )?.workspaceCwd;
      return (
        ok && {
          ...joinOutcome(answer),
          ...(typeof workspaceCwd === 'string' ? { workspaceCwd } : {}),
        }
      );
    } finally {
      onBusy?.(false);
    }
  };
}

/** The dialog's "Join a coordinator" callback; a failed join throws. */
export function joinCoordinatorWith(
  join: (input: JoinCoordinatorInput) => Promise<unknown>,
  onBusy?: (busy: boolean) => void,
): (input: JoinCoordinatorInput) => Promise<RuntimeJoinOutcome> {
  return async (input) => {
    // The page waits while it runs: leaving it (New agent, Role templates,
    // Mention in chat, creating an agent on a runtime) would unmount the
    // dialog and drop the result. Leaving the Agents page altogether still
    // does, and so does leaving it after a result that landed while the
    // dialog was closed; the daemon logs a join that went through.
    onBusy?.(true);
    try {
      return joinOutcome(await join(input));
    } finally {
      onBusy?.(false);
    }
  };
}

/**
 * "Add runtime": hand another machine a one-line command, then wait for it to
 * show up. The dialog notices the new runtime through the same roster poll
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
  onJoinCoordinator,
  onCreateAgentOn,
  replacementTarget,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The coordinator address this page talks to; the link's default. */
  serverUrl: string;
  runtimes: readonly RuntimeSummary[];
  onCreateJoinToken: (supersedesHostId?: string) => Promise<JoinToken>;
  onConnectExisting?: (
    input: ConnectExistingInput,
  ) => Promise<RuntimeJoinOutcome>;
  /** Joins THIS daemon to another coordinator; absent hides that entry. */
  onJoinCoordinator?: (
    input: JoinCoordinatorInput,
  ) => Promise<RuntimeJoinOutcome>;
  onCreateAgentOn?: (runtimeId: string) => void;
  replacementTarget?: RuntimeSummary;
}) {
  const { t } = useI18n();
  const [method, setMethod] = useState<'command' | 'existing' | 'join'>(
    'command',
  );
  const [joinLink, setJoinLink] = useState('');
  const [joinToken, setJoinToken] = useState('');
  // The link a kept token was sent with: it is kept for that link's retry
  // only, never carried to another coordinator.
  const [keptTokenLink, setKeptTokenLink] = useState<string>();
  const [joinAllowHttp, setJoinAllowHttp] = useState(false);
  // The coordinator this daemon joined, once it accepted.
  const [joined, setJoined] = useState<string>();
  const joinTarget = useMemo(() => parseJoinLink(joinLink), [joinLink]);
  const methods: ReadonlyArray<'command' | 'existing' | 'join'> =
    onJoinCoordinator
      ? ['command', 'existing', 'join']
      : ['command', 'existing'];
  const [address, setAddress] = useState(serverUrl);
  const [join, setJoin] = useState<JoinToken>();
  const [watch, setWatch] = useState<RuntimeWatch>();
  // What went wrong, kept with the form whose attempt it was (a join command
  // or a join), and shown only while that form is on screen. `joinSent`: the
  // join's came back from a join that was sent, not from checking the form.
  const [errors, setErrors] = useState<{
    command?: string;
    join?: string;
    joinSent?: boolean;
  }>({});
  const setError = (
    where: 'command' | 'join',
    message?: string,
    sent = false,
  ) =>
    setErrors((current) => ({
      ...current,
      [where]: message,
      ...(where === 'join' ? { joinSent: sent } : {}),
    }));
  // Why a computer that joined could not save the connection, one per
  // machine: this one (`here`, from the join form, shown on its joined
  // result, with `hereRecorded` saying whether a rerun of that join goes on)
  // and the remote (`there`, from the address-and-token form, shown under
  // that form, and on the remote's connected result). An attempt replaces
  // only its own, and a close drops only what was on screen.
  const [notSaved, setNotSaved] = useState<{
    here?: string;
    there?: string;
    hereRecorded?: boolean;
  }>({});
  // A join or connect in flight, read synchronously: a second submit in the
  // same tick (a double Enter) sees it before `busy` re-renders. Closing
  // does not cancel the request, so it stays in flight, the dialog stays busy
  // if it is reopened, and its result shows when it settles.
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const replacementHostId = replacementTarget?.id;

  // New runtimes, in roster order: a computer that enrolls is listed last.
  const fresh = useMemo(
    () =>
      watch
        ? runtimes.filter(
            (runtime) =>
              runtime.kind === 'external' &&
              runtime.status === 'online' &&
              !watch.known.has(runtime.id),
          )
        : [],
    [runtimes, watch],
  );
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
    // Waiting for that remote alone, no other computer is the one waited
    // for. Otherwise the first listed, as before: a computer that enrolls
    // is listed last, so a result on screen stays when another one enrolls
    // meanwhile.
    return awaitsRemote(watch) && !join
      ? fresh.find((runtime) => isWatchedRemote(watch, runtime))
      : fresh[0];
  }, [replacementHostId, runtimes, watch, join, fresh]);
  // Whose the connected result is: the remote's carries its notice.
  const connectedRemote =
    watch !== undefined &&
    connected !== undefined &&
    isWatchedRemote(watch, connected);
  // A connected result waits while a request is in flight: it would replace
  // the form that sent it, and its Create-agent button leave the page.
  const showsConnected = connected !== undefined && !busy;
  const waiting = open && watch !== undefined && !showsConnected;
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
    setError('command');
    try {
      if (!safeHost(address)) throw new Error(t('collab.runtime.badAddress'));
      setJoin(await onCreateJoinToken(replacementHostId));
      setWatch((previous) => ({
        at: Date.now(),
        known: replacementHostId
          ? new Set(runtimes.map((runtime) => runtime.id))
          : onlineIds(runtimes),
        // A remote connected from the other form that has not shown up yet.
        ...(awaitsRemote(previous) ? { remote: previous!.remote } : {}),
      }));
    } catch (cause) {
      setError(
        'command',
        cause instanceof Error ? cause.message : String(cause),
      );
    } finally {
      setBusy(false);
    }
  };

  const submitExisting = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!onConnectExisting || inFlight.current) return;
    const data = new FormData(event.currentTarget);
    inFlight.current = true;
    setBusy(true);
    setNotSaved((current) => ({ ...current, there: undefined }));
    // The coordinator keeps one enrollment token, and a remote connect
    // issues its own: a join command created before may no longer work.
    setJoin(undefined);
    const known = onlineIds(runtimes);
    try {
      const outcome = await onConnectExisting({
        remoteUrl: String(data.get('remoteUrl')),
        remoteToken: String(data.get('remoteToken')),
        remoteCwd: String(data.get('remoteCwd')),
        serverUrl: address,
        allowHttp: data.get('allowHttp') === 'on',
      });
      if (outcome) {
        const { saveError, workspaceCwd } = outcome;
        const mayBeOnline =
          workspaceCwd !== undefined &&
          runtimes.some(
            (runtime) =>
              runtime.kind === 'external' &&
              known.has(runtime.id) &&
              runtime.workspaceCwd === workspaceCwd,
          );
        setWatch({
          at: Date.now(),
          known,
          remote: {
            ...(workspaceCwd !== undefined ? { workspaceCwd } : {}),
            ...(mayBeOnline ? { mayBeOnline: true as const } : {}),
          },
        });
        if (saveError !== undefined) {
          setNotSaved((current) => ({ ...current, there: saveError }));
        }
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const submitJoin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!onJoinCoordinator || inFlight.current) return;
    // A new join replaces the previous one's notice, even one stopped by
    // validation.
    setNotSaved((current) => ({
      ...current,
      here: undefined,
      hereRecorded: undefined,
    }));
    if (!joinTarget) {
      setError('join', t('collab.runtime.joinBadLink'));
      return;
    }
    // The daemon would refuse it before using the token: say so here, where
    // the token can stay.
    if (!joinAllowHttp && refusesPlainHttp(joinTarget.serverUrl)) {
      setError('join', t('collab.runtime.joinNeedsHttp'));
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError('join');
    try {
      const outcome = await onJoinCoordinator({
        serverUrl: joinTarget.serverUrl,
        workspaceId: joinTarget.workspaceId,
        enrollmentToken: joinToken.trim(),
        allowHttp: joinAllowHttp,
      });
      if (outcome) {
        setJoined(joinTarget.serverUrl);
        setJoinToken('');
        setKeptTokenLink(undefined);
        if (outcome.saveError !== undefined) {
          const here = outcome.saveError;
          const hereRecorded = outcome.recorded !== false;
          setNotSaved((current) => ({ ...current, here, hereRecorded }));
        }
      }
    } catch (cause) {
      // The same token sent again picks up what a failed join did (its
      // answer lost, or its first heartbeat failed), so it is kept for the
      // link it was sent with; only one the coordinator refused is dropped.
      // A failure that never reached the daemon sent nothing: the token is
      // the user's own, unbound, and survives any link edit.
      if (isRefusedJoinToken(cause)) {
        setJoinToken('');
        setKeptTokenLink(undefined);
      } else if (!isDaemonUnavailableError(cause)) {
        setKeptTokenLink(joinLink);
      }
      const name = (cause as Error | undefined)?.name;
      setError(
        'join',
        name === 'TimeoutError' || name === 'TypeError'
          ? // With what the browser said, in case it was something else.
            t('collab.runtime.joinTimedOut', {
              error: (cause as Error).message,
            })
          : cause instanceof Error
            ? cause.message
            : String(cause),
        true,
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const minutesLeft = join
    ? Math.max(0, Math.ceil((join.expiresAt - now) / 60_000))
    : 0;
  // An expired link is no use to copy; offer a new one instead.
  const live = join && minutesLeft > 0 ? join : undefined;
  // `here` belongs to the joined result, `there` to its form and to the
  // remote's connected result: the joined result takes the dialog over
  // first.
  const shownHere = joined !== undefined ? notSaved.here : undefined;
  const shownThere =
    !joined && (showsConnected ? connectedRemote : method === 'existing')
      ? notSaved.there
      : undefined;
  // Whose error is on screen: not over the joined result, nor under another
  // form (a join that failed after a tab switch keeps it for when its form
  // is back). Over a connected result, the join's, said to be the join's:
  // hidden there, it would go with the page once Create agent on… is used.
  const shownErrorOf: 'command' | 'join' | undefined = joined
    ? undefined
    : showsConnected
      ? // Not one from checking the form: what it points at is not there.
        errors.join !== undefined && errors.joinSent
        ? 'join'
        : undefined
      : method !== 'existing' && errors[method] !== undefined
        ? method
        : undefined;
  const shownError =
    shownErrorOf === undefined
      ? undefined
      : showsConnected
        ? t('collab.runtime.joinFailed', { error: errors.join ?? '' })
        : errors[shownErrorOf];
  // Once a machine has joined, the next opening starts over, so a second
  // one can be added.
  const close = (next: boolean) => {
    // A joined result is shown over a connected one, which then stays for
    // the next opening.
    if (!next && showsConnected && !joined) {
      // What the wait still waits for: the remote, when this is another
      // computer, and a join command's computer, when this is the remote
      // and the command still works or another computer came meanwhile.
      const remoteLeft = awaitsRemote(watch) && !connectedRemote;
      const commandLeft =
        connectedRemote &&
        join !== undefined &&
        (join.expiresAt > Date.now() ||
          fresh.some((runtime) => runtime.id !== connected?.id));
      if (watch && connected && (remoteLeft || commandLeft)) {
        setWatch({
          at: watch.at,
          known: new Set([...watch.known, connected.id]),
          ...(remoteLeft ? { remote: watch.remote } : {}),
        });
        if (!commandLeft) setJoin(undefined);
      } else {
        setJoin(undefined);
        setWatch(undefined);
      }
    }
    if (!next && joined) {
      setJoined(undefined);
      setJoinLink('');
    }
    if (!next && shownErrorOf !== undefined) setError(shownErrorOf);
    if (!next) {
      setNotSaved((current) => ({
        ...(shownHere === undefined
          ? { here: current.here, hereRecorded: current.hereRecorded }
          : {}),
        ...(shownThere === undefined ? { there: current.there } : {}),
      }));
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

        {joined ? (
          <div
            role="status"
            className="flex items-center gap-3 rounded-md border border-[var(--status-done-fg)]/30 bg-[var(--status-done-bg)] p-3"
          >
            <CheckCircle2
              aria-hidden="true"
              className="size-5 shrink-0 text-[var(--status-done-fg)]"
            />
            <p className="min-w-0 font-medium break-all">
              {t('collab.runtime.joinConnected', { server: joined })}
            </p>
          </div>
        ) : showsConnected && connected ? (
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
                    programs: runtimePrograms(connected)
                      .map(programLabel)
                      .join(', '),
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
                {methods.map((value) => (
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
                      : value === 'existing'
                        ? t('collab.runtime.methodExisting')
                        : t('collab.runtime.methodJoin')}
                  </button>
                ))}
              </div>
            )}

            {method === 'join' && !replacementTarget ? null : (
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium">
                  {t('collab.runtime.address')}
                </span>
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
            )}

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
            ) : method === 'join' ? (
              // Its own key, like the form below: both sit in the same
              // place, and React would otherwise reuse one's inputs for the
              // other, carrying a typed token into a visible field. Both are
              // read-only while a request is in flight, so what it answers is
              // about the fields on screen.
              <form
                key="join-coordinator"
                id="join-coordinator"
                className="flex flex-col gap-3 text-sm"
                onSubmit={(event) => void submitJoin(event)}
              >
                <p className="text-xs text-muted-foreground">
                  {t('collab.runtime.joinDescription')}
                </p>
                <label className="flex flex-col gap-1.5">
                  {t('collab.runtime.joinLink')}
                  <Input
                    name="joinLink"
                    required
                    readOnly={busy}
                    value={joinLink}
                    onChange={(event) => {
                      const link = event.target.value;
                      setJoinLink(link);
                      // A token kept from a failed join belongs to the link
                      // it was sent with; another coordinator must not
                      // receive it.
                      if (
                        keptTokenLink !== undefined &&
                        link !== keptTokenLink
                      ) {
                        setKeptTokenLink(undefined);
                        setJoinToken('');
                      }
                    }}
                    placeholder="https://coordinator:4170/join/<workspace>"
                    aria-invalid={
                      joinLink.trim() !== '' && !joinTarget ? true : undefined
                    }
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  {t('collab.runtime.joinToken')}
                  <Input
                    name="enrollmentToken"
                    type="password"
                    autoComplete="off"
                    required
                    readOnly={busy}
                    value={joinToken}
                    onChange={(event) => {
                      // A typed token is the user's own, not one kept from
                      // a failed join.
                      setKeptTokenLink(undefined);
                      setJoinToken(event.target.value);
                    }}
                  />
                </label>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    name="allowHttp"
                    disabled={busy}
                    checked={joinAllowHttp}
                    onChange={(event) => setJoinAllowHttp(event.target.checked)}
                  />
                  {t('collab.runtime.allowHttp')}
                </label>
                {joinTarget ? (
                  <div className="flex flex-col gap-1.5">
                    <p className="text-xs text-muted-foreground">
                      {t('collab.runtime.joinCli')}
                    </p>
                    {/* The typed token is not echoed into a copyable line. */}
                    <CommandLine
                      text={joinCoordinatorCommand(joinLink, '', joinAllowHttp)}
                    />
                  </div>
                ) : null}
              </form>
            ) : (
              <form
                key="connect-existing-runtime"
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
                    readOnly={busy}
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
                    readOnly={busy}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  {t('collab.runtime.remoteCwd')}
                  <Input
                    name="remoteCwd"
                    required
                    readOnly={busy}
                    placeholder="/home/me/project"
                  />
                </label>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" name="allowHttp" disabled={busy} />
                  {t('collab.runtime.allowHttp')}
                </label>
              </form>
            )}
          </>
        )}

        {(
          [
            ['collab.runtime.notSavedHere', shownHere, notSaved.hereRecorded],
            ['collab.runtime.notSavedThere', shownThere, undefined],
          ] as const
        ).map(([key, saveError, recorded]) =>
          saveError === undefined ? null : (
            <p
              key={key}
              role="status"
              className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-muted-foreground break-words"
            >
              {t(key, {
                error: saveError,
                recorded: recorded === false ? 'false' : 'true',
              })}
            </p>
          ),
        )}

        {shownError && (
          <p role="alert" className="text-sm text-destructive">
            {shownError}
          </p>
        )}

        <DialogFooter>
          {joined ? (
            <Button variant="outline" onClick={() => close(false)}>
              {t('collab.runtime.done')}
            </Button>
          ) : showsConnected && connected ? (
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
              <Button variant="outline" onClick={() => close(false)}>
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
          ) : method === 'join' ? (
            <Button
              type="submit"
              form="join-coordinator"
              disabled={busy || !joinTarget || !joinToken.trim()}
            >
              {t('collab.runtime.connect')}
            </Button>
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
