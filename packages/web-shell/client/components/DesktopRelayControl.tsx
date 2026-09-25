/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { MonitorIcon } from 'lucide-react';
import type { DaemonWorkspaceCapability } from '@qwen-code/sdk/daemon';
import {
  useConnection,
  useWorkspace,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useI18n } from '../i18n';
import {
  DESKTOP_RELAY_INSTALL_COMMAND,
  connectDesktopRelay,
  disconnectDesktopRelay,
  probeDesktopRelay,
  type DesktopRelayProbe,
} from '../desktop-relay/desktop-relay-client';
import { resolveLocalFilesWorkspaceRoute } from './LocalFilesControl';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Spinner } from './ui/spinner';
import { cn } from '@/lib/utils';

export type DesktopRelayPhase =
  | 'unavailable'
  | 'needs-session'
  | 'checking'
  | 'permission-required'
  | 'missing'
  | 'idle'
  | 'awaiting-approval'
  | 'connecting'
  | 'connected'
  | 'other-session'
  | 'failed';

export type DesktopRelayBlocker =
  | 'insecure-context'
  | 'unsupported-daemon'
  | 'workspace-ineligible'
  | 'workspace-resolving';

const COPY = {
  en: {
    'desktopRelay.title': 'This computer',
    'desktopRelay.trigger': 'Use this computer',
    'desktopRelay.hint':
      'Lets this session run code on this computer and see and control its screen, for Computer Use. You approve each connection in a dialog on this computer.',
    'desktopRelay.connect': 'Connect this computer',
    'desktopRelay.disconnect': 'Disconnect',
    'desktopRelay.checkAgain': 'Check again',
    'desktopRelay.copy': 'Copy command',
    'desktopRelay.copied': 'Copied',
    'desktopRelay.setupHint':
      'Set up once: run this in a terminal on this computer, then check again. It registers a macOS launchd socket; nothing keeps running in the background.',
    'desktopRelay.approveHint':
      'Approve the request in the dialog that opened on this computer.',
    'desktopRelay.otherSessionHint':
      'This computer is connected to another session. Connecting here replaces that connection.',
    'desktopRelay.needsSessionHint':
      'Start a session first. The connection binds to exactly one session.',
    'desktopRelay.status.checking': 'Checking…',
    'desktopRelay.status.permissionRequired': 'Browser permission required',
    'desktopRelay.status.missing': 'Not set up',
    'desktopRelay.status.idle': 'Not connected',
    'desktopRelay.status.awaitingApproval': 'Waiting for approval',
    'desktopRelay.status.connecting': 'Connecting…',
    'desktopRelay.status.connected': 'Connected',
    'desktopRelay.status.otherSession': 'In use by another session',
    'desktopRelay.status.failed': 'Failed',
    'desktopRelay.status.unavailable': 'Unavailable here',
    'desktopRelay.status.needsSession': 'Waiting for a session',
    'desktopRelay.blocker.insecureContext':
      'Browsers only let a secure page reach this computer. Open the Web Shell over https, or forward the daemon port with SSH and open http://localhost:<port>.',
    'desktopRelay.blocker.unsupportedDaemon':
      'This daemon does not advertise the reverse tool channel (client_mcp_over_ws). Start it with QWEN_SERVE_CLIENT_MCP_OVER_WS=1.',
    'desktopRelay.blocker.workspaceIneligible':
      "This conversation's workspace cannot use this computer (untrusted or live workspace).",
    'desktopRelay.blocker.workspaceResolving':
      'Which workspace this conversation belongs to is not known yet.',
    'desktopRelay.permissionHint':
      'Allow local network access for this site in the browser prompt or site settings, then check again.',
    'desktopRelay.error.denied': 'The request was declined on this computer.',
    'desktopRelay.error.unreachable':
      'Could not reach the desktop relay on this computer.',
  },
  'zh-CN': {
    'desktopRelay.title': '这台电脑',
    'desktopRelay.trigger': '使用这台电脑',
    'desktopRelay.hint':
      '让当前会话在这台电脑上运行代码、查看并操作屏幕，用于 Computer Use。每次连接都要在这台电脑弹出的对话框里确认。',
    'desktopRelay.connect': '连接这台电脑',
    'desktopRelay.disconnect': '断开',
    'desktopRelay.checkAgain': '重新检测',
    'desktopRelay.copy': '复制命令',
    'desktopRelay.copied': '已复制',
    'desktopRelay.setupHint':
      '只需设置一次：在这台电脑的终端里运行下面的命令，然后重新检测。它注册一个 macOS launchd socket，平时没有进程在后台运行。',
    'desktopRelay.approveHint': '请在这台电脑弹出的对话框里确认。',
    'desktopRelay.otherSessionHint':
      '这台电脑已连接到另一个会话。在这里连接会替换那个连接。',
    'desktopRelay.needsSessionHint': '请先创建一个会话。连接只绑定一个会话。',
    'desktopRelay.status.checking': '检测中…',
    'desktopRelay.status.permissionRequired': '需要浏览器权限',
    'desktopRelay.status.missing': '未设置',
    'desktopRelay.status.idle': '未连接',
    'desktopRelay.status.awaitingApproval': '等待确认',
    'desktopRelay.status.connecting': '连接中…',
    'desktopRelay.status.connected': '已连接',
    'desktopRelay.status.otherSession': '被其他会话使用中',
    'desktopRelay.status.failed': '连接失败',
    'desktopRelay.status.unavailable': '当前环境不可用',
    'desktopRelay.status.needsSession': '等待会话',
    'desktopRelay.blocker.insecureContext':
      '浏览器只允许安全页面访问这台电脑。请通过 https 访问 Web Shell，或用 SSH 转发 daemon 端口后打开 http://localhost:<port>。',
    'desktopRelay.blocker.unsupportedDaemon':
      '该 daemon 未启用反向工具通道（client_mcp_over_ws）。请以 QWEN_SERVE_CLIENT_MCP_OVER_WS=1 启动它。',
    'desktopRelay.blocker.workspaceIneligible':
      '该会话的工作区不能使用这台电脑（不受信任或 live 工作区）。',
    'desktopRelay.blocker.workspaceResolving': '尚不能确定该会话所属的工作区。',
    'desktopRelay.permissionHint':
      '请在浏览器提示或网站设置中允许本地网络访问，然后重新检测。',
    'desktopRelay.error.denied': '请求在这台电脑上被拒绝。',
    'desktopRelay.error.unreachable': '无法连接到这台电脑上的桌面中继。',
  },
} as const;

type CopyKey = keyof (typeof COPY)['en'];

function useDesktopRelayCopy(): (key: CopyKey) => string {
  const { language } = useI18n();
  return useCallback((key: CopyKey) => COPY[language][key], [language]);
}

export interface DesktopRelayStatus {
  phase: DesktopRelayPhase;
  blocker?: DesktopRelayBlocker;
  message?: string;
}

const STATUS_KEY: Record<DesktopRelayPhase, CopyKey> = {
  unavailable: 'desktopRelay.status.unavailable',
  'needs-session': 'desktopRelay.status.needsSession',
  checking: 'desktopRelay.status.checking',
  'permission-required': 'desktopRelay.status.permissionRequired',
  missing: 'desktopRelay.status.missing',
  idle: 'desktopRelay.status.idle',
  'awaiting-approval': 'desktopRelay.status.awaitingApproval',
  connecting: 'desktopRelay.status.connecting',
  connected: 'desktopRelay.status.connected',
  'other-session': 'desktopRelay.status.otherSession',
  failed: 'desktopRelay.status.failed',
};

const BLOCKER_KEY: Record<DesktopRelayBlocker, CopyKey> = {
  'insecure-context': 'desktopRelay.blocker.insecureContext',
  'unsupported-daemon': 'desktopRelay.blocker.unsupportedDaemon',
  'workspace-ineligible': 'desktopRelay.blocker.workspaceIneligible',
  'workspace-resolving': 'desktopRelay.blocker.workspaceResolving',
};

const BUSY: readonly DesktopRelayPhase[] = [
  'checking',
  'awaiting-approval',
  'connecting',
];
const CAN_CONNECT: readonly DesktopRelayPhase[] = [
  'idle',
  'failed',
  'other-session',
];
const CAN_DISCONNECT: readonly DesktopRelayPhase[] = [
  'connecting',
  'connected',
  'other-session',
];

function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).toString() === new URL(b).toString();
  } catch {
    return a === b;
  }
}

/** Maps what the relay reports onto what this session can do next. */
export function deriveDesktopRelayStatus(input: {
  blocker: DesktopRelayBlocker | undefined;
  sessionId: string | undefined;
  daemonUrl: string | undefined;
  probe: DesktopRelayProbe | undefined;
  awaitingApproval: boolean;
  error: string | undefined;
}): DesktopRelayStatus {
  if (input.blocker !== undefined) {
    return { phase: 'unavailable', blocker: input.blocker };
  }
  if (!input.sessionId || !input.daemonUrl) return { phase: 'needs-session' };
  if (input.awaitingApproval) return { phase: 'awaiting-approval' };
  if (input.probe === undefined) return { phase: 'checking' };
  if (input.probe.kind === 'permission-required') {
    return { phase: 'permission-required' };
  }
  if (input.probe.kind === 'missing') return { phase: 'missing' };
  const active = input.probe.active;
  const live =
    active !== undefined &&
    (active.phase === 'connecting' ||
      active.phase === 'registering' ||
      active.phase === 'connected');
  if (
    active !== undefined &&
    active.sessionId === input.sessionId &&
    sameUrl(active.daemonUrl, input.daemonUrl)
  ) {
    if (active.phase === 'connected') return { phase: 'connected' };
    if (live) return { phase: 'connecting' };
    if (active.phase === 'failed') {
      return { phase: 'failed', message: input.error ?? active.message };
    }
  } else if (live) {
    return { phase: 'other-session' };
  }
  if (input.error !== undefined)
    return { phase: 'failed', message: input.error };
  return { phase: 'idle' };
}

export interface DesktopRelayPanelProps {
  status: DesktopRelayStatus;
  installCommand: string;
  copied: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onCheckAgain: () => void;
  onCopyCommand: () => void;
}

/** The popover body, prop-driven so every phase is testable without a daemon. */
export function DesktopRelayPanel({
  status,
  installCommand,
  copied,
  onConnect,
  onDisconnect,
  onCheckAgain,
  onCopyCommand,
}: DesktopRelayPanelProps) {
  const t = useDesktopRelayCopy();
  const { phase } = status;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        {BUSY.includes(phase) ? <Spinner /> : null}
        <h2 className="text-sm font-medium">{t('desktopRelay.title')}</h2>
        <span className="ml-auto text-xs text-muted-foreground">
          {t(STATUS_KEY[phase])}
        </span>
      </div>

      <p className="text-xs text-muted-foreground">{t('desktopRelay.hint')}</p>

      {phase === 'unavailable' && status.blocker ? (
        <p className="text-xs text-muted-foreground">
          {t(BLOCKER_KEY[status.blocker])}
        </p>
      ) : null}

      {phase === 'needs-session' ? (
        <p className="text-xs text-muted-foreground">
          {t('desktopRelay.needsSessionHint')}
        </p>
      ) : null}

      {phase === 'missing' ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            {t('desktopRelay.setupHint')}
          </p>
          <code className="block break-all rounded bg-muted px-2 py-1 font-mono text-xs">
            {installCommand}
          </code>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onCopyCommand}
            >
              {copied ? t('desktopRelay.copied') : t('desktopRelay.copy')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onCheckAgain}
            >
              {t('desktopRelay.checkAgain')}
            </Button>
          </div>
        </div>
      ) : null}

      {phase === 'permission-required' ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-xs text-muted-foreground">
            {t('desktopRelay.permissionHint')}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCheckAgain}
          >
            {t('desktopRelay.checkAgain')}
          </Button>
        </div>
      ) : null}

      {phase === 'awaiting-approval' ? (
        <p className="text-xs text-muted-foreground">
          {t('desktopRelay.approveHint')}
        </p>
      ) : null}

      {phase === 'other-session' ? (
        <p className="text-xs text-muted-foreground">
          {t('desktopRelay.otherSessionHint')}
        </p>
      ) : null}

      {phase === 'failed' && status.message ? (
        <p className="text-xs text-destructive" role="alert">
          {status.message}
        </p>
      ) : null}

      {CAN_CONNECT.includes(phase) || CAN_DISCONNECT.includes(phase) ? (
        <div className="flex gap-2">
          {CAN_CONNECT.includes(phase) ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onConnect}
            >
              {t('desktopRelay.connect')}
            </Button>
          ) : null}
          {CAN_DISCONNECT.includes(phase) ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onDisconnect}
            >
              {t('desktopRelay.disconnect')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface DesktopRelayControlProps {
  /** Class for the trigger, supplied by the sidebar so it matches its neighbours. */
  triggerClassName: string;
  workspaces?: readonly DaemonWorkspaceCapability[];
}

/**
 * "Use this computer": asks the relay on the viewer's computer to lend its
 * node_repl to this session over the daemon's reverse tool channel.
 */
export function DesktopRelayControl({
  triggerClassName,
  workspaces,
}: DesktopRelayControlProps) {
  const t = useDesktopRelayCopy();
  const { baseUrl, token, capabilities } = useWorkspace();
  const { sessionId, workspaceCwd } = useConnection();
  const [open, setOpen] = useState(false);
  const [probe, setProbe] = useState<DesktopRelayProbe | undefined>(undefined);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);

  // Same routing and withholding rules as the local-files bridge, which uses
  // the same reverse channel.
  const route = useMemo(
    () =>
      resolveLocalFilesWorkspaceRoute({
        capabilities,
        workspaces,
        workspaceCwd: workspaceCwd ?? undefined,
        sessionId: sessionId ?? undefined,
      }),
    [capabilities, workspaces, workspaceCwd, sessionId],
  );
  // Browsers only let a secure page reach a loopback address.
  const blocker: DesktopRelayBlocker | undefined =
    typeof window !== 'undefined' && !window.isSecureContext
      ? 'insecure-context'
      : capabilities !== undefined &&
          !capabilities.features?.includes('client_mcp_over_ws')
        ? 'unsupported-daemon'
        : route.kind === 'none'
          ? 'workspace-ineligible'
          : route.kind === 'pending'
            ? 'workspace-resolving'
            : undefined;
  const daemonUrl = useMemo(() => {
    try {
      return new URL(baseUrl || '/', window.location.href).toString();
    } catch {
      return undefined;
    }
  }, [baseUrl]);

  const status = deriveDesktopRelayStatus({
    blocker,
    sessionId: sessionId ?? undefined,
    daemonUrl,
    probe,
    awaitingApproval,
    error,
  });

  const refresh = useCallback(async () => {
    setProbe(await probeDesktopRelay());
  }, []);

  // Probe only when someone looks, or while a connection is live: an
  // unprompted request to a loopback port can raise the browser's
  // local-network permission prompt. Every probe starts a short process on
  // the computer, so a steady connection is checked rarely.
  const watching =
    status.phase === 'connecting' || status.phase === 'connected';
  const interval =
    open || status.phase === 'connecting' ? 3_000 : watching ? 30_000 : 0;
  useEffect(() => {
    if (interval === 0) return;
    void refresh();
    const timer = setInterval(() => void refresh(), interval);
    return () => clearInterval(timer);
  }, [interval, refresh]);

  const connect = useCallback(async () => {
    if (!sessionId || !daemonUrl) return;
    setError(undefined);
    setAwaitingApproval(true);
    const result = await connectDesktopRelay({
      daemonUrl,
      sessionId,
      ...(token ? { token } : {}),
      ...(route.kind === 'qualified' ? { workspace: route.selector } : {}),
    });
    setAwaitingApproval(false);
    if (!result.ok) {
      setError(
        result.code === 'denied'
          ? t('desktopRelay.error.denied')
          : result.code === 'unreachable'
            ? t('desktopRelay.error.unreachable')
            : (result.message ?? result.code),
      );
    }
    await refresh();
  }, [daemonUrl, refresh, route, sessionId, t, token]);

  const disconnect = useCallback(async () => {
    setError(undefined);
    await disconnectDesktopRelay();
    await refresh();
  }, [refresh]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(DESKTOP_RELAY_INSTALL_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      // The command stays on screen to copy by hand.
    }
  }, []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn('relative', triggerClassName)}
          aria-label={t('desktopRelay.trigger')}
          title={t('desktopRelay.trigger')}
        >
          <MonitorIcon size={16} strokeWidth={1.2} aria-hidden="true" />
          {watching ? (
            <span
              aria-hidden="true"
              className={cn(
                'absolute right-1 bottom-1 h-1.5 w-1.5 rounded-full',
                status.phase === 'connected'
                  ? 'bg-primary'
                  : 'bg-muted-foreground',
              )}
            />
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <DesktopRelayPanel
          status={status}
          installCommand={DESKTOP_RELAY_INSTALL_COMMAND}
          copied={copied}
          onConnect={() => void connect()}
          onDisconnect={() => void disconnect()}
          onCheckAgain={() => void refresh()}
          onCopyCommand={() => void copy()}
        />
      </PopoverContent>
    </Popover>
  );
}
