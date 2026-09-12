import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import AppStyles from '../App.module.css';
import {
  getAllowedDaemonOrigin,
  getDaemonToken,
  navigateToDaemon,
  persistDaemonToken,
} from '../config/daemon';
import {
  getWorkspaceReturnUrl,
  openHostedWorkspace,
  readWorkspaceHosts,
  rememberWorkspaceHost,
} from '../config/workspace-hosts';
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
  confirmTarget: string;
  remoteHint: string;
  remoteUnreachable: string;
  addressLabel: string;
  tokenLabel: string;
  connect: string;
  retry: string;
  hint: string;
  local: string;
  previous: string;
}

// This gate renders before the app (and therefore before its I18nProvider), so
// it carries its own copy table instead of calling useI18n.
const COPY: Record<WebShellLanguage, AuthCopy> = {
  en: {
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
    confirmTarget:
      'This page points to a daemon this browser has not connected to before. Connect only if you trust it.',
    remoteHint:
      'The token is sent to the address shown above. Enter only a token issued by that daemon.',
    addressLabel: 'Daemon address',
    tokenLabel: 'Bearer token (optional)',
    connect: 'Connect',
    local: 'Return to local workspaces',
    previous: 'Return to previous session',
    retry: 'Retry',
    hint: 'This token grants full access to the daemon. Only enter it on a page you opened from the daemon terminal or its QR code.',
  },
  'zh-CN': {
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
    confirmTarget:
      '此页面指向一个本浏览器从未连接过的守护进程。仅在你信任它时再连接。',
    remoteHint: '令牌会发送到上方显示的地址。请只输入该守护进程签发的令牌。',
    addressLabel: 'Daemon 地址',
    tokenLabel: 'Bearer token（可选）',
    connect: '连接',
    local: '返回本地工作区',
    previous: '返回原会话',
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
  onChangeTarget?: (daemonOrigin: string, token?: string) => void;
  children: (token: string | undefined) => ReactNode;
}) {
  const copy = COPY[language] ?? COPY.en;
  const returnUrl = getWorkspaceReturnUrl();
  const [address, setAddress] = useState(initialAddress);
  const [hosts] = useState(readWorkspaceHosts);
  const [token, setToken] = useState(initialToken ?? '');
  const [accepted, setAccepted] = useState<{ token?: string }>();
  // Nothing is sent to an unconfirmed target until the user presses Connect.
  const [confirming, setConfirming] = useState(
    unconfirmedTarget && !invalidTarget,
  );
  const [status, setStatus] = useState(
    invalidTarget
      ? copy.invalidAddress
      : confirming
        ? copy.confirmTarget
        : copy.connecting,
  );
  const [busy, setBusy] = useState(!invalidTarget && !confirming);
  const [needsToken, setNeedsToken] = useState(false);
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
          if (!readWorkspaceHosts().some((host) => host.origin === baseUrl)) {
            rememberWorkspaceHost(baseUrl, []);
          }
          setAccepted({ token: candidate || undefined });
        } else if (response.status === 401) {
          setBusy(false);
          setNeedsToken(true);
          // A rejected stored/fragment credential must not stay pre-filled in
          // the masked input: recovery replaces the value, not appends to it.
          if (candidate && candidate === initialCandidateRef.current)
            setToken('');
          setStatus(
            candidate
              ? copyRef.current.invalidToken
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
    [baseUrl],
  );

  useEffect(() => {
    if (invalidTarget || confirming) return undefined;
    void connect(candidateRef.current);
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [connect, attempt, invalidTarget, confirming]);

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
          {!invalidTarget && (
            <CardDescription className="font-mono text-xs break-all">
              {baseUrl}
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
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!normalizedAddress) {
                setBusy(false);
                setStatus(copy.invalidAddress);
                return;
              }
              if (changingTarget) {
                onChangeTarget(
                  normalizedAddress,
                  token.trim() || getDaemonToken(normalizedAddress),
                );
                return;
              }
              // Confirming an unfamiliar target starts its first probe.
              if (confirming) setConfirming(false);
              operatorProbeRef.current = true;
              candidateRef.current = token.trim();
              setAttempt((n) => n + 1);
            }}
          >
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
                setAddress(event.target.value);
                setToken('');
              }}
            />
            <Label htmlFor="daemon-bearer-token">{copy.tokenLabel}</Label>
            <Input
              id="daemon-bearer-token"
              type="password"
              autoComplete="off"
              autoFocus={needsToken}
              placeholder={copy.tokenLabel}
              className="h-11 font-mono text-base tracking-[0.18em]"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
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
          <div className="flex flex-col gap-2">
            {returnUrl && (
              <Button variant="outline" asChild>
                <a href={returnUrl}>{copy.previous}</a>
              </Button>
            )}
            {(invalidTarget || baseUrl !== window.location.origin) && (
              <Button
                variant="outline"
                onClick={() => openHostedWorkspace(window.location.origin)}
              >
                {copy.local}
              </Button>
            )}
            {hosts
              .filter(
                (host) =>
                  host.origin !== baseUrl &&
                  host.origin !== window.location.origin,
              )
              .map((host) => (
                <Button
                  key={host.origin}
                  variant="outline"
                  onClick={() => openHostedWorkspace(host.origin)}
                >
                  {host.origin}
                </Button>
              ))}
          </div>
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
