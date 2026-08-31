import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppBridge,
  PostMessageTransport,
} from '@modelcontextprotocol/ext-apps/app-bridge';
import { McpAppHostContext } from '../../mcpAppHostContext';
import { useTheme } from '../../themeContext';
import styles from './McpApp.module.css';

type SandboxResource = Parameters<AppBridge['sendSandboxResourceReady']>[0];
type AppToolResult = Parameters<AppBridge['sendToolResult']>[0];

export interface McpAppDisplay {
  type: 'mcp_app';
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
): string | undefined {
  try {
    const host = new URL(hostUrl);
    const sandbox = new URL(daemonBaseUrl, host);
    if (
      !isLoopbackHostname(host.hostname) ||
      !isLoopbackHostname(sandbox.hostname)
    ) {
      return undefined;
    }
    // CSP cannot allow `http://[::1]:<port>`. Always rewrite IPv6
    // loopback onto localhost before checking same-origin swap.
    if (sandbox.hostname === '[::1]') {
      sandbox.hostname = 'localhost';
    }
    if (sandbox.origin === host.origin) {
      const alias = loopbackCrossOriginHostname(sandbox.hostname);
      if (alias) sandbox.hostname = alias;
    }
    sandbox.pathname = '/mcp-app-sandbox';
    sandbox.search = '';
    sandbox.hash = '';
    sandbox.searchParams.set('hostOrigin', host.origin);
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

function mcpAppHostContext(theme: ReturnType<typeof useTheme>) {
  return {
    theme,
    platform: 'web' as const,
    displayMode: 'inline' as const,
    availableDisplayModes: ['inline' as const],
    containerDimensions: { maxHeight: 640 },
  };
}

export function McpApp({ display }: { display: McpAppDisplay }) {
  const daemonBaseUrl = useContext(McpAppHostContext);
  const theme = useTheme();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<AppBridge | null>(null);
  const mountGenerationRef = useRef(0);
  const displayRef = useRef(display);
  const themeRef = useRef(theme);
  displayRef.current = display;
  themeRef.current = theme;
  const [height, setHeight] = useState(260);
  const [error, setError] = useState<string>();
  const cspKey = display.csp ? JSON.stringify(display.csp) : '';
  const toolArgumentsKey = JSON.stringify(display.toolArguments);
  const toolResultKey = JSON.stringify(display.toolResult);
  const sandboxUrl = useMemo(() => {
    if (!daemonBaseUrl || typeof window === 'undefined') return undefined;
    const resolved = resolveMcpAppSandboxUrl(
      daemonBaseUrl,
      window.location.href,
    );
    if (!resolved) return undefined;
    return applySandboxCspQuery(resolved, cspKey);
  }, [daemonBaseUrl, cspKey]);

  useEffect(() => {
    setError(undefined);
    const iframe = iframeRef.current;
    if (!iframe || !sandboxUrl) return;
    const generation = ++mountGenerationRef.current;
    let initialized = false;
    const current = displayRef.current;
    const bridge = new AppBridge(
      null,
      { name: 'qwen-code-web-shell', version: '0.0.1' },
      {
        sandbox: {
          ...(current.csp ? { csp: current.csp } : {}),
        },
      },
      { hostContext: mcpAppHostContext(themeRef.current) },
    );
    bridgeRef.current = bridge;

    bridge.onsandboxready = () => {
      const resource = displayRef.current;
      void bridge
        .sendSandboxResourceReady({
          html: resource.html,
          ...(resource.csp ? { csp: resource.csp } : {}),
        })
        .catch((reason: unknown) => setError(String(reason)));
    };
    bridge.oninitialized = () => {
      initialized = true;
      const resource = displayRef.current;
      void bridge
        .sendToolInput({ arguments: resource.toolArguments })
        .then(() => bridge.sendToolResult(resource.toolResult))
        .catch((reason: unknown) => setError(String(reason)));
    };
    bridge.onsizechange = ({ height: requestedHeight }) => {
      if (
        typeof requestedHeight === 'number' &&
        Number.isFinite(requestedHeight)
      ) {
        setHeight(Math.min(640, Math.max(120, Math.ceil(requestedHeight))));
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
        iframe.src = sandboxUrl;
      })
      .catch((reason: unknown) => setError(String(reason)));

    return () => {
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
    display.serverName,
    display.resourceUri,
    display.html,
    cspKey,
    toolArgumentsKey,
    toolResultKey,
  ]);

  useEffect(() => {
    bridgeRef.current?.setHostContext(mcpAppHostContext(theme));
  }, [theme]);

  if (!display.html || !sandboxUrl) {
    return <div className={styles.fallback}>{display.fallbackText}</div>;
  }

  return (
    <div className={styles.card} data-testid="mcp-app">
      <div className={styles.header}>
        <span>MCP App</span>
        <span className={styles.server}>{display.serverName}</span>
      </div>
      {error ? (
        <div className={styles.fallback}>{display.fallbackText}</div>
      ) : null}
      <iframe
        ref={iframeRef}
        title={`${display.serverName} MCP App`}
        className={styles.frame}
        style={{ height, display: error ? 'none' : undefined }}
        sandbox="allow-scripts allow-forms"
        referrerPolicy="origin"
        onError={() => setError('sandbox-load-failed')}
      />
    </div>
  );
}
