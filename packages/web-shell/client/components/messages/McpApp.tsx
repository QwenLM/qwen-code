import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppBridge,
  buildAllowAttribute,
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

export function resolveMcpAppSandboxUrl(
  daemonBaseUrl: string,
  hostUrl: string,
): string | undefined {
  try {
    const host = new URL(hostUrl);
    const sandbox = new URL(daemonBaseUrl, host);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(host.hostname) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(sandbox.hostname)
    ) {
      return undefined;
    }
    if (sandbox.origin === host.origin) {
      if (sandbox.hostname === 'localhost') sandbox.hostname = '127.0.0.1';
      else if (sandbox.hostname === '127.0.0.1') sandbox.hostname = 'localhost';
      else return undefined;
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

export function McpApp({ display }: { display: McpAppDisplay }) {
  const daemonBaseUrl = useContext(McpAppHostContext);
  const theme = useTheme();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(260);
  const [error, setError] = useState<string>();
  const sandboxUrl = useMemo(() => {
    if (!daemonBaseUrl || typeof window === 'undefined') return undefined;
    const resolved = resolveMcpAppSandboxUrl(
      daemonBaseUrl,
      window.location.href,
    );
    if (!resolved) return undefined;
    const url = new URL(resolved);
    if (display.csp) url.searchParams.set('csp', JSON.stringify(display.csp));
    return url.toString();
  }, [daemonBaseUrl, display.csp]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !sandboxUrl) return;
    let initialized = false;
    const bridge = new AppBridge(
      null,
      { name: 'qwen-code-web-shell', version: '0.0.1' },
      {
        sandbox: {
          ...(display.csp ? { csp: display.csp } : {}),
          ...(display.permissions ? { permissions: display.permissions } : {}),
        },
      },
      {
        hostContext: {
          theme,
          platform: 'web',
          displayMode: 'inline',
          availableDisplayModes: ['inline'],
          containerDimensions: { maxHeight: 640 },
        },
      },
    );

    bridge.onsandboxready = () => {
      void bridge
        .sendSandboxResourceReady({
          html: display.html,
          ...(display.csp ? { csp: display.csp } : {}),
          ...(display.permissions ? { permissions: display.permissions } : {}),
        })
        .catch((reason: unknown) => setError(String(reason)));
    };
    bridge.oninitialized = () => {
      initialized = true;
      void bridge
        .sendToolInput({ arguments: display.toolArguments })
        .then(() => bridge.sendToolResult(display.toolResult))
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
      if (initialized) {
        void bridge
          .teardownResource({}, { timeout: 500 })
          .catch(() => {})
          .finally(() => bridge.close().catch(() => {}));
        return;
      }
      void bridge.close().catch(() => {});
    };
  }, [display, sandboxUrl, theme]);

  if (!sandboxUrl) {
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
      ) : (
        <iframe
          ref={iframeRef}
          title={`${display.serverName} MCP App`}
          className={styles.frame}
          style={{ height }}
          sandbox="allow-scripts allow-same-origin allow-forms"
          allow={buildAllowAttribute(display.permissions)}
          referrerPolicy="origin"
        />
      )}
    </div>
  );
}
