import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import AppStyles from '../App.module.css';
import {
  confirmDaemonTarget,
  getAllowedDaemonOrigin,
  getDaemonToken,
  navigateToDaemon,
  persistDaemonToken,
} from '../config/daemon';
import {
  completeRemoteConnectionAdd,
  isRemoteConnectionAddActive,
  leaveRemoteConnectionAdd,
} from '../config/remote-connections';
import {
  isRemoteWorkspaceAddActive,
  leaveRemoteWorkspaceAdd,
} from '../config/remote-workspace-add';
import type { WebShellLanguage } from '../i18n';
import { WebShellThemeId, type WebShellTheme } from '../themeContext';
import { Button } from './ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from './ui/card';
import { Input } from './ui/input';
import { Label } from './ui/label';

// A probe must give up well before the SDK's own 30s fetch timeout
// (DaemonClient DEFAULT_FETCH_TIMEOUT_MS) so the gate keeps retrying while the
// daemon cold-starts a runtime instead of hanging on one request.
const PROBE_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 2_000;
// Ceiling for a server-supplied Retry-After: a front proxy or rate limiter
// may ask for minutes, which would park the gate screen far past operator
// patience; re-probing at the ceiling is cheap and self-correcting.
const MAX_RETRY_DELAY_MS = 30_000;

interface AuthCopy {
  heading: string;
  connecting: string;
  starting: string;
  unreachable: string;
  notReady: string;
  startFailed: string;
  invalidToken: string;
  enterToken: string;
  policyBlocked: string;
  invalidAddress: string;
  addressChanged: string;
  confirmTarget: string;
  remoteHint: string;
  remoteUnreachable: string;
  switchUnavailable: string;
  addressLabel: string;
  tokenLabel: string;
  connect: string;
  retry: string;
  hint: string;
  local: string;
  remoteAddCancel: string;
  connectionAddCancel: string;
  pairingFailed: string;
}

// This gate renders before the app (and therefore before its I18nProvider), so
// it carries its own copy table instead of calling useI18n.
const COPY: Record<WebShellLanguage, AuthCopy> = {
  en: {
    pairingFailed:
      'Pairing failed or the QR code expired. Scan a fresh QR code, or enter the daemon token.',
    heading: 'Connect to Qwen Code',
    connecting: 'Connecting…',
    starting: 'Daemon is starting…',
    unreachable: 'Cannot reach the daemon. Retrying…',
    remoteUnreachable:
      'Cannot reach the daemon. Retrying… Check the address, network, HTTPS certificate, and --allow-origin for this page origin.',
    notReady: 'Daemon is not ready. Retrying…',
    startFailed: 'Daemon failed to start.',
    invalidToken:
      'Invalid or expired token. Enter the token from the daemon terminal.',
    enterToken: 'Enter the bearer token from the daemon terminal.',
    policyBlocked:
      'Access blocked by the daemon Origin or Host policy. Open its direct address, or check --allow-origin for cross-origin access.',
    invalidAddress: 'Invalid daemon address. Enter an HTTP or HTTPS origin.',
    addressChanged:
      'Connection paused. Select Connect to use the entered address.',
    confirmTarget:
      'This page points to a daemon this browser has not connected to before. Connect only if you trust it.',
    remoteHint:
      'The token is sent to the address shown above. Enter only a token issued by that daemon.',
    switchUnavailable:
      'Browser storage is unavailable, so the token could not be carried to that daemon.',
    addressLabel: 'Daemon address',
    tokenLabel: 'Bearer token (optional)',
    connect: 'Connect',
    local: 'Return to local workspaces',
    remoteAddCancel: 'Cancel adding workspace',
    connectionAddCancel: 'Cancel adding connection',
    retry: 'Retry',
    hint: 'This token grants full access to the daemon. Only enter it on a page you opened from the daemon terminal or its QR code.',
  },
  'zh-CN': {
    pairingFailed:
      '配对失败或二维码已过期。请扫描新的二维码，或输入 daemon 令牌。',
    heading: '连接到 Qwen Code',
    connecting: '正在连接…',
    starting: '守护进程正在启动…',
    unreachable: '无法访问守护进程，正在重试…',
    remoteUnreachable:
      '无法访问守护进程，正在重试… 请检查地址、网络、HTTPS 证书，以及 --allow-origin 是否允许当前页面来源。',
    notReady: '守护进程尚未就绪，正在重试…',
    startFailed: '守护进程启动失败。',
    invalidToken: '令牌无效或已过期，请输入守护进程终端中显示的令牌。',
    enterToken: '请输入守护进程终端中显示的 bearer token。',
    policyBlocked:
      '访问被守护进程的 Origin 或 Host 策略拦截。请直接打开守护进程地址，或检查 --allow-origin 以允许跨域访问。',
    invalidAddress: 'Daemon 地址无效。请输入 HTTP 或 HTTPS origin。',
    addressChanged: '连接已暂停。点击“连接”以使用填写的地址。',
    confirmTarget:
      '此页面指向一个本浏览器从未连接过的守护进程。仅在你信任它时再连接。',
    remoteHint: '令牌会发送到上方显示的地址。请只输入该守护进程签发的令牌。',
    switchUnavailable: '浏览器存储不可用，因此无法把 token 带到该 daemon。',
    addressLabel: 'Daemon 地址',
    tokenLabel: 'Bearer token（可选）',
    connect: '连接',
    local: '返回本地工作区',
    remoteAddCancel: '取消添加工作区',
    connectionAddCancel: '取消添加连接',
    retry: '重试',
    hint: '该令牌拥有守护进程的完整访问权限。请仅在从守护进程终端或其二维码打开的页面中输入。',
  },
};

/** `Retry-After` in milliseconds (delta-seconds or HTTP-date), or undefined. */
function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('Retry-After');
  if (!raw) return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(Math.max(seconds, 1) * 1000, MAX_RETRY_DELAY_MS);
  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(Math.max(date - Date.now(), 1000), MAX_RETRY_DELAY_MS);
}

export function StandaloneAuth({
  baseUrl,
  initialToken,
  initialAddress = baseUrl,
  language = 'en',
  theme = WebShellThemeId.Dark,
  invalidTarget = false,
  unconfirmedTarget = false,
  pairingFailed = false,
  onChangeTarget = navigateToDaemon,
  children,
}: {
  baseUrl: string;
  initialToken?: string;
  initialAddress?: string;
  /** Selects the gate copy. Defaults to English when omitted. */
  language?: WebShellLanguage;
  /** Selects the theme palette the app root will apply after mount. */
  theme?: WebShellTheme;
  invalidTarget?: boolean;
  /** The daemon came from a link to an origin this browser has not used. */
  unconfirmedTarget?: boolean;
  pairingFailed?: boolean;
  onChangeTarget?: (
    daemonOrigin: string,
    token?: string,
    options?: {
      continueFlow?: 'workspace' | 'connection';
    },
  ) => boolean | void;
  children: (token: string | undefined) => ReactNode;
}) {
  const copy = COPY[language] ?? COPY.en;
  const remoteWorkspaceAddActive = isRemoteWorkspaceAddActive();
  const remoteConnectionAddActive = isRemoteConnectionAddActive();
  const [address, setAddress] = useState(initialAddress);
  const [token, setToken] = useState(initialToken ?? '');
  const [accepted, setAccepted] = useState<{ token?: string }>();
  // Nothing is sent to an unconfirmed target until the user presses Connect.
  const [confirming, setConfirming] = useState(
    unconfirmedTarget && !invalidTarget,
  );
  // A failed pairing exchange parks the gate on the rescan copy only when
  // there is no credential left to try; with one (a stored device token) the
  // boot probe still runs, and the rescan copy surfaces if the daemon rejects
  // it. Session storage outlives a daemon restart, so "a credential exists"
  // is not "a credential worked".
  const awaitingPairing = pairingFailed && !initialToken;
  const [status, setStatus] = useState(
    invalidTarget
      ? copy.invalidAddress
      : confirming
        ? copy.confirmTarget
        : awaitingPairing
          ? copy.pairingFailed
          : copy.connecting,
  );
  const [busy, setBusy] = useState(
    !awaitingPairing && !invalidTarget && !confirming,
  );
  // Focus the token field only when entering a token is the pending step: an
  // invalid or unconfirmed target asks for the address (or a trust decision)
  // first, and the token input's later autoFocus would otherwise win focus.
  const [needsToken, setNeedsToken] = useState(
    awaitingPairing && !invalidTarget && !confirming,
  );
  // Every probe — the first one, a manual retry, and each auto-retry — is one
  // bump of this counter, so exactly one effect run owns the in-flight request
  // and aborts its predecessor on cleanup.
  const [attempt, setAttempt] = useState(0);
  const candidateRef = useRef(initialToken ?? '');
  // Distinguish an operator-initiated probe from an automatic retry: only
  // the operator's probe may reset the button and the live region. Every
  // cold-start cycle otherwise flips a possibly-focused control and
  // re-announces two strings once per retry for the whole window.
  const operatorProbeRef = useRef(true);
  // Remember the credential the gate started with so a 401 against it can be
  // told apart from a 401 against something the operator just typed.
  const initialCandidateRef = useRef(initialToken ?? '');
  const controllerRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read through a ref so a language change re-labels the gate without
  // re-probing the daemon.
  const copyRef = useRef(copy);
  copyRef.current = copy;

  // Stop the probe loop synchronously. Clearing the controller alone is not
  // enough: `retryIn`'s ownership check runs only when a response lands, so an
  // already-armed timer would still bump `attempt` and relaunch the probe
  // through the effect.
  const retireProbe = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const connect = useCallback(
    async (candidate: string) => {
      const controller = new AbortController();
      controllerRef.current = controller;
      if (operatorProbeRef.current) {
        operatorProbeRef.current = false;
        setBusy(true);
        // Reset the live region too: keeping the previous outcome (e.g.
        // "Invalid or expired token…") on screen for the whole in-flight
        // probe leaves a screen-reader user without any announcement that
        // the submit landed. retryIn overwrites this once the outcome is
        // known. The automatic retry leaves both alone, so the transient
        // copy and an enabled button survive the whole cold start.
        setStatus(copyRef.current.connecting);
      }
      const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      // Transient failures re-probe on their own and leave the button enabled,
      // so a manual retry can always jump the queue.
      const retryIn = (delayMs: number, message: string): void => {
        if (controllerRef.current !== controller) return;
        setBusy(false);
        setStatus(message);
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setAttempt((n) => n + 1), delayMs);
      };
      try {
        const response = await fetch(`${baseUrl}/capabilities`, {
          headers: candidate ? { Authorization: `Bearer ${candidate}` } : {},
          signal: controller.signal,
        });
        if (controllerRef.current !== controller) return;
        if (response.ok) {
          persistDaemonToken(candidate, baseUrl);
          confirmDaemonTarget(baseUrl);
          if (
            remoteConnectionAddActive &&
            completeRemoteConnectionAdd(baseUrl)
          ) {
            return;
          }
          setAccepted({ token: candidate || undefined });
        } else if (response.status === 401) {
          setBusy(false);
          setNeedsToken(true);
          // A rejected stored/fragment credential must not stay pre-filled in
          // the masked input: recovery replaces the value, not appends to it.
          // Only that credential is dropped. The field stays editable while an
          // automatic retry is outstanding, so a value typed during that window
          // is not what this 401 rejected and must survive it.
          if (candidate && candidate === initialCandidateRef.current)
            setToken((current) => (current === candidate ? '' : current));
          // A boot credential rejected after a failed pairing exchange points
          // at the rescan recovery, not the terminal-token copy a phone user
          // cannot act on; a rejected hand-typed token keeps the token copy.
          // An empty submit on the rescan screen keeps the rescan copy too:
          // "enter the daemon token" would drop the one instruction the phone
          // user can act on, and no later state change would restore it.
          setStatus(
            candidate
              ? pairingFailed && candidate === initialCandidateRef.current
                ? copyRef.current.pairingFailed
                : copyRef.current.invalidToken
              : pairingFailed
                ? copyRef.current.pairingFailed
                : copyRef.current.enterToken,
          );
        } else if (response.status === 403) {
          setBusy(false);
          setNeedsToken(false);
          setStatus(copyRef.current.policyBlocked);
        } else {
          // The daemon discriminates permanent startup failure by body.code,
          // not by the absence of Retry-After: front proxies and the rate
          // limiter also emit bare 503/429, which are transient here.
          const body: unknown = await response.json().catch(() => undefined);
          if (controllerRef.current !== controller) return;
          const code =
            typeof body === 'object' && body !== null
              ? (body as { code?: unknown }).code
              : undefined;
          if (code === 'daemon_runtime_failed') {
            const detail =
              typeof (body as { error?: unknown }).error === 'string'
                ? (body as { error: string }).error
                : undefined;
            setBusy(false);
            setStatus(
              detail
                ? `${copyRef.current.startFailed} ${detail}`
                : copyRef.current.startFailed,
            );
          } else {
            const retryAfter = retryAfterMs(response);
            retryIn(
              retryAfter ?? RETRY_DELAY_MS,
              response.status === 503
                ? copyRef.current.starting
                : copyRef.current.notReady,
            );
          }
        }
      } catch {
        // Network error, or our own timeout abort. An abort from a manual
        // retry or from unmount is caught by retryIn's ownership check.
        retryIn(
          RETRY_DELAY_MS,
          baseUrl === window.location.origin
            ? copyRef.current.unreachable
            : copyRef.current.remoteUnreachable,
        );
      } finally {
        clearTimeout(timeout);
      }
    },
    [baseUrl, pairingFailed, remoteConnectionAddActive],
  );

  useEffect(() => {
    if (invalidTarget || confirming || (awaitingPairing && attempt === 0))
      return undefined;
    void connect(candidateRef.current);
    return retireProbe;
  }, [
    connect,
    attempt,
    invalidTarget,
    confirming,
    awaitingPairing,
    retireProbe,
  ]);

  if (accepted) return children(accepted.token);
  const normalizedAddress = getAllowedDaemonOrigin(address.trim());
  const changingTarget = invalidTarget || normalizedAddress !== baseUrl;
  return (
    <div
      // The generated Tailwind utilities and shadcn tokens are scoped to the
      // Web Shell root; the gate renders before App mounts, so it opts into
      // the same scope and theme palette the app root uses (App.tsx).
      data-web-shell-root
      data-web-shell-shadcn
      data-web-shell-gate
      className={`flex min-h-screen items-center justify-center bg-background p-6 text-foreground ${
        theme === WebShellThemeId.Light
          ? AppStyles.themeLight
          : `${AppStyles.themeDark} dark`
      }`}
    >
      <Card className="w-full max-w-md">
        <CardHeader className="items-center text-center">
          <CardTitle className="text-2xl">{copy.heading}</CardTitle>
          {normalizedAddress && (
            <CardDescription className="font-mono text-xs break-all">
              {normalizedAddress}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <p
            role="status"
            className="text-center text-sm text-muted-foreground"
          >
            {status}
          </p>
          {/* The address field is `type="url"`, so native constraint validation
              would block submit — and this handler's localized invalid-address
              copy — for the likeliest malformed input, a bare `IP:port`. The
              app-level check below is the stricter one: it also rejects
              non-http(s) schemes, credentials, paths, queries and hashes. */}
          <form
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (!normalizedAddress) {
                setBusy(false);
                setStatus(copy.invalidAddress);
                return;
              }
              if (changingTarget) {
                const candidate =
                  token.trim() || getDaemonToken(normalizedAddress);
                const switched = remoteWorkspaceAddActive
                  ? onChangeTarget(normalizedAddress, candidate, {
                      continueFlow: 'workspace',
                    })
                  : remoteConnectionAddActive
                    ? onChangeTarget(normalizedAddress, candidate, {
                        continueFlow: 'connection',
                      })
                    : onChangeTarget(normalizedAddress, candidate);
                if (switched === false) {
                  setBusy(false);
                  setStatus(copy.switchUnavailable);
                }
                return;
              }
              // Confirming an unfamiliar target starts its first probe.
              if (confirming) setConfirming(false);
              operatorProbeRef.current = true;
              candidateRef.current = token.trim();
              setAttempt((n) => n + 1);
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="daemon-address">{copy.addressLabel}</Label>
              <Input
                id="daemon-address"
                type="url"
                inputMode="url"
                autoComplete="url"
                autoFocus={invalidTarget}
                placeholder="https://daemon.example.com:4170"
                className="h-11 font-mono"
                value={address}
                onChange={(event) => {
                  retireProbe();
                  setConfirming(true);
                  setBusy(false);
                  setStatus(copy.addressChanged);
                  setAddress(event.target.value);
                  setToken('');
                }}
              />
            </div>
            {/* No placeholder: it would repeat the label above and pick up the
                masked value's wide tracking. */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="daemon-bearer-token">{copy.tokenLabel}</Label>
              <Input
                id="daemon-bearer-token"
                type="password"
                autoComplete="off"
                autoFocus={needsToken}
                className="h-11 font-mono text-base tracking-[0.18em]"
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            </div>
            <Button
              type="submit"
              size="lg"
              className="h-11 w-full text-base"
              disabled={busy && !changingTarget}
            >
              {changingTarget || confirming
                ? copy.connect
                : busy
                  ? copy.connecting
                  : needsToken
                    ? copy.connect
                    : copy.retry}
            </Button>
          </form>
          {(remoteWorkspaceAddActive ||
            remoteConnectionAddActive ||
            invalidTarget ||
            baseUrl !== window.location.origin) && (
            <Button
              variant="outline"
              onClick={() => {
                // Retiring the target has to retire its probe loop first:
                // assigning a new URL does not stop the JS event loop, and the
                // document stays live until the navigation commits — long
                // enough, on a cold-starting local daemon, for a queued retry to
                // re-probe the daemon being left with its stored bearer token
                // and mount the app on it.
                retireProbe();
                setConfirming(true);
                if (remoteWorkspaceAddActive && leaveRemoteWorkspaceAdd()) {
                  return;
                }
                if (remoteConnectionAddActive && leaveRemoteConnectionAdd()) {
                  return;
                }
                onChangeTarget(window.location.origin);
              }}
            >
              {remoteWorkspaceAddActive
                ? copy.remoteAddCancel
                : remoteConnectionAddActive
                  ? copy.connectionAddCancel
                  : copy.local}
            </Button>
          )}
        </CardContent>
        <CardFooter className="justify-center">
          <p className="text-center text-xs text-muted-foreground">
            {copy.hint}
            {normalizedAddress &&
              normalizedAddress !== window.location.origin &&
              ` ${copy.remoteHint}`}
          </p>
        </CardFooter>
      </Card>
    </div>
  );
}
