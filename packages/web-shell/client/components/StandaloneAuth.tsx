import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import AppStyles from '../App.module.css';
import { persistDaemonToken } from '../config/daemon';
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
  tokenLabel: string;
  connect: string;
  retry: string;
  hint: string;
}

// This gate renders before the app (and therefore before its I18nProvider), so
// it carries its own copy table instead of calling useI18n.
const COPY: Record<WebShellLanguage, AuthCopy> = {
  en: {
    heading: 'Connect to Qwen Code',
    connecting: 'Connecting…',
    starting: 'Daemon is starting…',
    unreachable: 'Cannot reach the daemon. Retrying…',
    notReady: 'Daemon is not ready. Retrying…',
    startFailed: 'Daemon failed to start.',
    invalidToken:
      'Invalid or expired token. Enter the token from the daemon terminal.',
    enterToken: 'Enter the bearer token from the daemon terminal.',
    policyBlocked:
      'Access blocked by the daemon Origin or Host policy. Open its direct address, or check --allow-origin for cross-origin access.',
    tokenLabel: 'Bearer token',
    connect: 'Connect',
    retry: 'Retry',
    hint: 'This token grants full access to the daemon. Only enter it on a page you opened from the daemon terminal or its QR code.',
  },
  'zh-CN': {
    heading: '连接到 Qwen Code',
    connecting: '正在连接…',
    starting: '守护进程正在启动…',
    unreachable: '无法访问守护进程，正在重试…',
    notReady: '守护进程尚未就绪，正在重试…',
    startFailed: '守护进程启动失败。',
    invalidToken: '令牌无效或已过期，请输入守护进程终端中显示的令牌。',
    enterToken: '请输入守护进程终端中显示的 bearer token。',
    policyBlocked:
      '访问被守护进程的 Origin 或 Host 策略拦截。请直接打开守护进程地址，或检查 --allow-origin 以允许跨域访问。',
    tokenLabel: 'Bearer token',
    connect: '连接',
    retry: '重试',
    hint: '该令牌拥有守护进程的完整访问权限。请仅在从守护进程终端或其二维码打开的页面中输入。',
  },
};

/** `Retry-After` in milliseconds, or undefined when it is absent or unusable. */
function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('Retry-After');
  if (!raw) return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.max(seconds, 1) * 1000;
}

/** A permanently failed startup reports its reason as `{ error }` JSON. */
async function startupError(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body?.error === 'string' && body.error
      ? body.error
      : undefined;
  } catch {
    return undefined;
  }
}

export function StandaloneAuth({
  baseUrl,
  initialToken,
  language = 'en',
  theme = WebShellThemeId.Dark,
  children,
}: {
  baseUrl: string;
  initialToken?: string;
  /** Selects the gate copy. Defaults to English when omitted. */
  language?: WebShellLanguage;
  /** Selects the theme palette the app root will apply after mount. */
  theme?: WebShellTheme;
  children: (token: string | undefined) => ReactNode;
}) {
  const copy = COPY[language] ?? COPY.en;
  const [token, setToken] = useState(initialToken ?? '');
  const [accepted, setAccepted] = useState<{ token?: string }>();
  const [status, setStatus] = useState(copy.connecting);
  const [busy, setBusy] = useState(true);
  const [needsToken, setNeedsToken] = useState(false);
  // Every probe — the first one, a manual retry, and each auto-retry — is one
  // bump of this counter, so exactly one effect run owns the in-flight request
  // and aborts its predecessor on cleanup.
  const [attempt, setAttempt] = useState(0);
  const candidateRef = useRef(initialToken ?? '');
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
      setBusy(true);
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
          if (candidate) persistDaemonToken(candidate);
          setAccepted({ token: candidate || undefined });
        } else if (response.status === 401) {
          setBusy(false);
          setNeedsToken(true);
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
          const retryAfter = retryAfterMs(response);
          if (retryAfter !== undefined) {
            // Cold start in progress: the daemon says when to come back.
            retryIn(retryAfter, copyRef.current.starting);
          } else if (response.status === 503) {
            // 503 without Retry-After means the runtime failed for good.
            // Report it and stop; only a manual retry probes again.
            const detail = await startupError(response);
            if (controllerRef.current !== controller) return;
            setBusy(false);
            setStatus(
              detail
                ? `${copyRef.current.startFailed} ${detail}`
                : copyRef.current.startFailed,
            );
          } else {
            retryIn(RETRY_DELAY_MS, copyRef.current.notReady);
          }
        }
      } catch {
        // Network error, or our own timeout abort. An abort from a manual
        // retry or from unmount is caught by retryIn's ownership check.
        retryIn(RETRY_DELAY_MS, copyRef.current.unreachable);
      } finally {
        clearTimeout(timeout);
      }
    },
    [baseUrl],
  );

  useEffect(() => {
    void connect(candidateRef.current);
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [connect, attempt]);

  if (accepted) return children(accepted.token);
  return (
    <div
      // The generated Tailwind utilities and shadcn tokens are scoped to the
      // Web Shell root; the gate renders before App mounts, so it opts into
      // the same scope and theme palette the app root uses (App.tsx).
      data-web-shell-root
      data-web-shell-shadcn
      className={`flex min-h-screen items-center justify-center bg-background p-6 text-foreground ${
        theme === WebShellThemeId.Light
          ? AppStyles.themeLight
          : `${AppStyles.themeDark} dark`
      }`}
    >
      <Card className="w-full max-w-md">
        <CardHeader className="items-center text-center">
          <CardTitle className="text-2xl">{copy.heading}</CardTitle>
          <CardDescription className="font-mono text-xs break-all">
            {baseUrl}
          </CardDescription>
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
              candidateRef.current = token.trim();
              setAttempt((n) => n + 1);
            }}
          >
            {needsToken && (
              <>
                <Label htmlFor="daemon-bearer-token" className="sr-only">
                  {copy.tokenLabel}
                </Label>
                <Input
                  id="daemon-bearer-token"
                  type="password"
                  autoComplete="off"
                  autoFocus
                  placeholder={copy.tokenLabel}
                  className="h-11 text-center font-mono text-base tracking-[0.18em]"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                />
              </>
            )}
            <Button
              type="submit"
              size="lg"
              className="h-11 w-full text-base"
              disabled={busy}
            >
              {busy ? copy.connecting : needsToken ? copy.connect : copy.retry}
            </Button>
          </form>
        </CardContent>
        <CardFooter className="justify-center">
          <p className="text-center text-xs text-muted-foreground">
            {copy.hint}
          </p>
        </CardFooter>
      </Card>
    </div>
  );
}
