import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppBridge,
  PostMessageTransport,
  type McpUiStyles,
} from '@modelcontextprotocol/ext-apps/app-bridge';
import {
  McpAppHostContext,
  useMcpAppAdmission,
  isBuiltInGeneratedUi,
  isBundledGeneratedUi,
  McpAppMessagesContext,
  McpAppSessionContext,
  McpAppToolsContext,
  McpAppGeneratedUiOwnerContext,
  McpAppVisibilityContext,
} from '../../mcpAppHostContext';
import { useI18n } from '../../i18n';
import { useTheme } from '../../themeContext';
import styles from './McpApp.module.css';
import {
  GeneratedUiSlot,
  useGeneratedUiRetention,
} from '../../generated-ui/GeneratedUiRuntimeProvider';
import { Button } from '../ui/button';
import type { GeneratedUiInstance } from '../../generated-ui/instance-store';

type SandboxResource = Parameters<AppBridge['sendSandboxResourceReady']>[0];
type AppToolResult = Parameters<AppBridge['sendToolResult']>[0];

export interface McpAppDisplay {
  type: 'mcp_app';
  requiredFeature?: 'generated-ui';
  serverName: string;
  resourceUri: string;
  html: string;
  toolResult: AppToolResult;
  toolArguments: Record<string, unknown>;
  fallbackText: string;
  csp?: SandboxResource['csp'];
  permissions?: SandboxResource['permissions'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getMcpAppDisplay(value: unknown): McpAppDisplay | undefined {
  if (!isRecord(value) || value['type'] !== 'mcp_app') return undefined;
  if (
    typeof value['serverName'] !== 'string' ||
    typeof value['resourceUri'] !== 'string' ||
    typeof value['html'] !== 'string' ||
    typeof value['fallbackText'] !== 'string' ||
    !isRecord(value['toolResult']) ||
    !isRecord(value['toolArguments'])
  ) {
    return undefined;
  }
  return value as unknown as McpAppDisplay;
}

// Must stay under Node's default 16 KiB HTTP request-line limit.
const MAX_SANDBOX_QUERY_LENGTH = 8192;

function isLoopbackHostname(hostname: string): boolean {
  const octets = hostname.split('.');
  const isIpv4Loopback =
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.slice(1).every((octet) => {
      if (!/^\d+$/.test(octet)) return false;
      const value = Number(octet);
      return value >= 0 && value <= 255;
    });
  return hostname === 'localhost' || hostname === '[::1]' || isIpv4Loopback;
}

function loopbackCrossOriginHostname(hostname: string): string | undefined {
  if (hostname === '127.0.0.1' || hostname === '[::1]') return 'localhost';
  return undefined;
}

export function resolveMcpAppSandboxUrl(
  daemonBaseUrl: string,
  hostUrl: string,
  dataMode = false,
): string | undefined {
  try {
    const host = new URL(hostUrl);
    const sandbox = new URL(daemonBaseUrl, host);
    if (
      !['http:', 'https:'].includes(host.protocol) ||
      !['http:', 'https:'].includes(sandbox.protocol) ||
      sandbox.username ||
      sandbox.password
    )
      return undefined;
    dataMode ||=
      host.protocol === 'https:' ||
      !isLoopbackHostname(host.hostname) ||
      !isLoopbackHostname(sandbox.hostname);
    if (!dataMode) {
      // The dedicated HTTP listener uses localhost, including for IPv6 binds.
      if (sandbox.hostname === '[::1]') sandbox.hostname = 'localhost';
      if (sandbox.origin === host.origin) {
        const alias = loopbackCrossOriginHostname(sandbox.hostname);
        if (alias) sandbox.hostname = alias;
      }
    }
    sandbox.pathname = `${sandbox.pathname.replace(/\/$/, '')}/mcp-app-sandbox`;
    sandbox.search = '';
    sandbox.hash = '';
    sandbox.searchParams.set('hostOrigin', host.origin);
    if (dataMode) sandbox.searchParams.set('mode', 'data');
    return sandbox.toString();
  } catch {
    return undefined;
  }
}

export function applySandboxCspQuery(
  sandboxUrl: string,
  cspJson: string,
): string {
  if (!cspJson) return sandboxUrl;
  const url = new URL(sandboxUrl);
  url.searchParams.set('csp', cspJson);
  return url.search.length <= MAX_SANDBOX_QUERY_LENGTH
    ? url.toString()
    : sandboxUrl;
}

// Cards grow with their content up to this height, then scroll inside.
const MAX_APP_HEIGHT = 960;
// The built-in card sizes its view to the content, so it gets one page-level
// scroll instead of a nested scroll area inside the transcript.
const MAX_GENERATED_UI_HEIGHT = 4000;

// Standard MCP App style variables resolved from the Web Shell tokens the
// card itself sees, so Apps can match the current theme instead of the
// operating system's color scheme. Secondary text uses the token that keeps
// readable contrast in each theme.
function hostStyleVariables(
  element: Element | null,
  theme: ReturnType<typeof useTheme>,
): Record<string, string> | undefined {
  if (!element || typeof getComputedStyle !== 'function') return undefined;
  const computed = getComputedStyle(element);
  const tokens: Record<string, string> = {
    '--color-background-primary': '--background',
    '--color-background-secondary': '--muted',
    '--color-background-inverse': '--primary',
    '--color-text-primary': '--foreground',
    '--color-text-secondary':
      theme === 'light' ? '--secondary-foreground' : '--muted-foreground',
    '--color-text-inverse': '--primary-foreground',
    '--color-text-danger': '--destructive',
    '--color-border-primary': '--border',
    '--color-border-secondary': '--input',
    '--color-ring-primary': '--ring',
    '--font-sans': '--font-sans',
    '--border-radius-md': '--radius',
  };
  const variables: Record<string, string> = {};
  for (const [name, token] of Object.entries(tokens)) {
    const value = computed.getPropertyValue(token).trim();
    if (value) variables[name] = value;
  }
  return Object.keys(variables).length ? variables : undefined;
}

function mcpAppHostContext(
  maxHeight: number,
  theme: ReturnType<typeof useTheme>,
  locale: string,
  variables?: Record<string, string>,
) {
  return {
    theme,
    locale,
    // Hosts may send any subset of the standard variables.
    ...(variables
      ? {
          styles: {
            variables: variables as Partial<McpUiStyles> as McpUiStyles,
          },
        }
      : {}),
    platform: 'web' as const,
    displayMode: 'inline' as const,
    availableDisplayModes: ['inline' as const],
    containerDimensions: { maxHeight },
  };
}

// Share the limit across cards so App requests leave HTTP/1.1 connections for
// session events and approval requests. Hold the slot until the request settles.
let activeAppToolCalls = 0;
const waitingAppToolCalls = new Set<() => void>();

function acquireAppToolSlot(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      waitingAppToolCalls.delete(start);
      reject(signal.reason);
    };
    const start = () => {
      signal.removeEventListener('abort', cancel);
      activeAppToolCalls += 1;
      resolve(() => {
        activeAppToolCalls -= 1;
        const next = waitingAppToolCalls.values().next().value;
        if (next) {
          waitingAppToolCalls.delete(next);
          next();
        }
      });
    };
    if (signal.aborted) reject(signal.reason);
    else if (activeAppToolCalls < 2) start();
    else {
      waitingAppToolCalls.add(start);
      signal.addEventListener('abort', cancel, { once: true });
    }
  });
}

// The readable title and summary a Generated UI result carries; the raw
// fallback text also contains its structured JSON for the model.
function generatedUiSummary(
  display: McpAppDisplay,
): { title: string; summary: string } | undefined {
  const structured = display.toolResult['structuredContent'];
  if (!structured || typeof structured !== 'object') return undefined;
  const { title, summary } = structured as Record<string, unknown>;
  return typeof title === 'string' && typeof summary === 'string'
    ? { title, summary }
    : undefined;
}

/** The saved title and summary of a Generated UI card, as readable text. */
export function GeneratedUiSummary({ display }: { display: McpAppDisplay }) {
  const readable = generatedUiSummary(display);
  return readable ? (
    <>
      <div className={styles.fallbackTitle}>{readable.title}</div>
      <div className={styles.fallbackSummary}>{readable.summary}</div>
    </>
  ) : (
    <div>{display.fallbackText}</div>
  );
}

export function GeneratedUiFallback({ display }: { display: McpAppDisplay }) {
  const { t } = useI18n();
  return (
    <div className={styles.fallback}>
      <GeneratedUiSummary display={display} />
      <div className={styles.fallbackNote}>
        {t('mcpApp.generatedUi.unavailable')}
      </div>
    </div>
  );
}

export function McpApp({
  display,
  toolId,
  visible = true,
}: {
  display: McpAppDisplay;
  toolId?: string;
  visible?: boolean;
}) {
  const allowed = useMcpAppAdmission(display);
  const retention = useGeneratedUiRetention();
  const owner = useContext(McpAppGeneratedUiOwnerContext)?.source;
  const sessionId = useContext(McpAppSessionContext);
  const surfaceVisible = useContext(McpAppVisibilityContext);
  if (
    import.meta.env.MODE !== 'transcript' &&
    allowed &&
    retention &&
    toolId &&
    isBuiltInGeneratedUi(display) &&
    owner?.eventEpoch &&
    owner.sessionId === sessionId
  )
    return surfaceVisible ? (
      <GeneratedUiSlot display={display} toolId={toolId} visible={visible} />
    ) : (
      <GeneratedUiFallback display={display} />
    );
  return allowed ? (
    <McpAppRuntime display={display} />
  ) : (
    <GeneratedUiFallback display={display} />
  );
}

export function McpAppRuntime({
  display,
  retained,
}: {
  display: McpAppDisplay;
  retained?: GeneratedUiInstance['runtime'];
}) {
  const { t, language } = useI18n();
  const builtInGeneratedUi = isBundledGeneratedUi(display);
  const maxHeight = builtInGeneratedUi
    ? MAX_GENERATED_UI_HEIGHT
    : MAX_APP_HEIGHT;
  const daemonBaseUrl = useContext(McpAppHostContext);
  const sessionId = useContext(McpAppSessionContext);
  const tools = useContext(McpAppToolsContext);
  const messages = useContext(McpAppMessagesContext);
  const messageHost =
    sessionId && messages?.sessionId === sessionId ? messages : undefined;
  const requestMessage =
    import.meta.env.MODE === 'transcript'
      ? undefined
      : messageHost?.requestMessage;
  const callTool =
    sessionId && tools?.sessionId === sessionId ? tools.callTool : undefined;
  const theme = useTheme();
  const languageRef = useRef(language);
  languageRef.current = language;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const bridgeRef = useRef<AppBridge | null>(null);
  const mountGenerationRef = useRef(0);
  const displayRef = useRef(display);
  const themeRef = useRef(theme);
  displayRef.current = display;
  themeRef.current = theme;
  const [height, setHeight] = useState(260);
  // Hidden until the App initializes, so a sandbox origin that is still
  // unreachable (for example a forwarded port) never shows a browser error page.
  const [appReady, setAppReady] = useState(false);
  const [error, setError] = useState<string>();
  const [dataSandbox, setDataSandbox] = useState(false);
  const cspKey = display.csp ? JSON.stringify(display.csp) : '';
  const toolArgumentsKey = JSON.stringify(display.toolArguments);
  const toolResultKey = JSON.stringify(display.toolResult);
  const sandboxUrl = useMemo(() => {
    if (!daemonBaseUrl || typeof window === 'undefined') return undefined;
    const resolved = resolveMcpAppSandboxUrl(
      daemonBaseUrl,
      window.location.href,
      dataSandbox,
    );
    if (!resolved) return undefined;
    return applySandboxCspQuery(resolved, cspKey);
  }, [daemonBaseUrl, cspKey, dataSandbox]);

  useEffect(() => {
    setError(undefined);
    setAppReady(false);
    const iframe = iframeRef.current;
    if (!iframe || !sandboxUrl) return;
    const generation = ++mountGenerationRef.current;
    let initialized = false;
    let active = true;
    let ready = false;
    const current = displayRef.current;
    const bridge = new AppBridge(
      null,
      { name: 'qwen-code-web-shell', version: '0.0.1' },
      {
        ...(callTool ? { serverTools: {} } : {}),
        ...(requestMessage ? { message: { text: {} } } : {}),
        sandbox: {
          ...(current.csp ? { csp: current.csp } : {}),
        },
      },
      {
        hostContext: mcpAppHostContext(
          maxHeight,
          themeRef.current,
          languageRef.current,
          hostStyleVariables(cardRef.current, themeRef.current),
        ),
      },
    );
    bridgeRef.current = bridge;
    const appAbort = new AbortController();
    let messagePending = false;
    if (requestMessage) {
      bridge.onmessage = async (params, extra) => {
        const signal = AbortSignal.any([
          extra.signal,
          appAbort.signal,
          ...(retained ? [retained.getSignal()] : []),
        ]);
        const content = params.content;
        if (
          signal.aborted ||
          messagePending ||
          params.role !== 'user' ||
          content.length !== 1 ||
          content[0]?.type !== 'text' ||
          content[0].text.length > 16 * 1024 ||
          !content[0].text.trim() ||
          new TextEncoder().encode(content[0].text).byteLength > 16 * 1024
        ) {
          return { isError: true };
        }
        messagePending = true;
        try {
          return await requestMessage({
            serverName: current.serverName,
            resourceUri: current.resourceUri,
            ...(isBundledGeneratedUi(current)
              ? { requiredFeature: 'generated-ui' as const }
              : {}),
            text: content[0].text,
            signal,
          });
        } catch {
          return { isError: true };
        } finally {
          messagePending = false;
        }
      };
    }
    if (callTool) {
      bridge.oncalltool = async (params, extra) => {
        const signal = AbortSignal.any([
          extra.signal,
          appAbort.signal,
          ...(retained ? [retained.getSignal()] : []),
        ]);
        let progress = 0;
        const progressToken = params._meta?.progressToken;
        // ext-apps omits the base MCP progress notification from its union.
        const sendProgress =
          extra.sendNotification as unknown as (notification: {
            method: 'notifications/progress';
            params: { progressToken: string | number; progress: number };
          }) => Promise<void>;
        const heartbeat =
          signal.aborted ||
          (typeof progressToken !== 'string' &&
            typeof progressToken !== 'number')
            ? undefined
            : setInterval(() => {
                void sendProgress({
                  method: 'notifications/progress',
                  params: { progressToken, progress: ++progress },
                }).catch(() => {});
              }, 30_000);
        const stopHeartbeat = () => clearInterval(heartbeat);
        signal.addEventListener('abort', stopHeartbeat, { once: true });
        let releaseSlot: (() => void) | undefined;
        try {
          releaseSlot = await acquireAppToolSlot(signal);
          signal.throwIfAborted();
          const result = await callTool(
            {
              serverName: current.serverName,
              resourceUri: current.resourceUri,
              name: params.name,
              arguments: params.arguments ?? {},
            },
            signal,
          );
          return result as AppToolResult;
        } finally {
          releaseSlot?.();
          stopHeartbeat();
          signal.removeEventListener('abort', stopHeartbeat);
        }
      };
    }

    const failInitialization = () => {
      if (!active || mountGenerationRef.current !== generation) return;
      active = false;
      clearTimeout(readyTimeout);
      bridge.oncalltool = undefined;
      bridge.onmessage = undefined;
      appAbort.abort();
      iframe.removeAttribute('src');
      bridgeRef.current = null;
      void bridge.close().catch(() => {});
      setError('sandbox-load-failed');
    };
    let readyTimeout = setTimeout(() => {
      if (!active) return;
      if (new URL(sandboxUrl).searchParams.get('mode') !== 'data') {
        setDataSandbox(true);
      } else failInitialization();
    }, 10_000);
    bridge.onsandboxready = () => {
      if (!active || ready) return;
      ready = true;
      clearTimeout(readyTimeout);
      readyTimeout = setTimeout(() => {
        if (active && !initialized) failInitialization();
      }, 30_000);
      const resource = displayRef.current;
      void bridge
        .sendSandboxResourceReady({
          html: resource.html,
          ...(resource.csp ? { csp: resource.csp } : {}),
        })
        .catch(failInitialization);
    };
    bridge.oninitialized = () => {
      if (!active) return;
      initialized = true;
      setAppReady(true);
      clearTimeout(readyTimeout);
      const resource = displayRef.current;
      void bridge
        .sendToolInput({ arguments: resource.toolArguments })
        .then(() => {
          if (active) return bridge.sendToolResult(resource.toolResult);
        })
        .catch(failInitialization);
    };
    bridge.onsizechange = ({ height: requestedHeight, width }) => {
      if (
        typeof requestedHeight === 'number' &&
        Number.isFinite(requestedHeight) &&
        // While the page reflows the App can briefly lay out at zero width
        // and report a height thousands of pixels tall; ignore that report.
        width !== 0 &&
        (!retained || (retained.isVisible() && requestedHeight > 0))
      ) {
        setHeight(
          Math.min(maxHeight, Math.max(120, Math.ceil(requestedHeight))),
        );
      }
    };

    void bridge
      .connect(
        new PostMessageTransport(
          iframe.contentWindow ?? undefined,
          iframe.contentWindow!,
        ),
      )
      .then(() => {
        if (active) iframe.src = sandboxUrl;
      })
      .catch(failInitialization);

    return () => {
      active = false;
      clearTimeout(readyTimeout);
      bridge.oncalltool = undefined;
      bridge.onmessage = undefined;
      appAbort.abort();
      bridgeRef.current = null;
      const unload = () => {
        // Compare against later effect runs so a superseded teardown
        // does not blank the iframe the next mount already owns.
        // eslint-disable-next-line react-hooks/exhaustive-deps -- live generation, not a stale copy
        if (mountGenerationRef.current === generation) {
          iframe.removeAttribute('src');
        }
        void bridge.close().catch(() => {});
      };
      if (initialized) {
        void bridge
          .teardownResource({}, { timeout: 500 })
          .catch(() => {})
          .finally(unload);
        return;
      }
      unload();
    };
  }, [
    sandboxUrl,
    dataSandbox,
    callTool,
    requestMessage,
    sessionId,
    display.serverName,
    display.resourceUri,
    display.html,
    cspKey,
    toolArgumentsKey,
    toolResultKey,
    retained,
    maxHeight,
  ]);

  useEffect(() => {
    bridgeRef.current?.setHostContext(
      mcpAppHostContext(
        maxHeight,
        theme,
        language,
        hostStyleVariables(cardRef.current, theme),
      ),
    );
  }, [theme, language, maxHeight]);

  if (!display.html || !sandboxUrl) {
    return <div className={styles.fallback}>{display.fallbackText}</div>;
  }

  return (
    <div ref={cardRef} className={styles.card} data-testid="mcp-app">
      {builtInGeneratedUi ? (
        // No MCP framing: one quiet row, only for the host's reset action.
        retained && (
          <div className={styles.builtInBar}>
            <span>
              {retained.reopened ? t('mcpApp.generatedUi.reopenNotice') : ''}
            </span>
            <Button
              variant="ghost"
              size="sm"
              title={t('mcpApp.generatedUi.reopenNotice')}
              onClick={retained.reset}
            >
              {t('mcpApp.generatedUi.reset')}
            </Button>
          </div>
        )
      ) : (
        <>
          <div className={styles.header}>
            <span>MCP App</span>
            <span className={styles.server}>{display.serverName}</span>
            {retained && (
              <Button
                variant="ghost"
                size="sm"
                title={t('mcpApp.generatedUi.reopenNotice')}
                onClick={retained.reset}
              >
                {t('mcpApp.generatedUi.reset')}
              </Button>
            )}
          </div>
          {retained?.reopened && (
            <div className={styles.fallback}>
              {t('mcpApp.generatedUi.reopenNotice')}
            </div>
          )}
        </>
      )}
      {error ? (
        <div className={styles.fallback}>
          {display.fallbackText || 'MCP App could not initialize.'}
        </div>
      ) : null}
      {!error && !appReady ? (
        <div className={styles.loading} role="status">
          {t(
            builtInGeneratedUi
              ? 'mcpApp.generatedUi.loading'
              : 'mcpApp.loading',
          )}
        </div>
      ) : null}
      <iframe
        ref={iframeRef}
        title={
          builtInGeneratedUi
            ? t('mcpApp.generatedUi.title')
            : `${display.serverName} MCP App`
        }
        className={styles.frame}
        style={{
          height,
          display: error ? 'none' : undefined,
          // Keep loading off-screen in layout terms but out of sight.
          ...(appReady
            ? {}
            : { position: 'absolute', visibility: 'hidden' as const }),
        }}
        sandbox="allow-scripts allow-forms allow-same-origin"
        referrerPolicy="origin"
        onError={() => setError('sandbox-load-failed')}
      />
    </div>
  );
}
