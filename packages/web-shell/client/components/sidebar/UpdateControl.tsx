import { useEffect, useRef, useState } from 'react';
import type { DaemonClient, DaemonUpdateStatus } from '@qwen-code/sdk/daemon';
import { ArrowUpCircleIcon, LoaderCircleIcon } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';

interface UpdateControlProps {
  client: Pick<
    DaemonClient,
    'daemonUpdateStatus' | 'prepareDaemonUpdate' | 'restartDaemonForUpdate'
  >;
  collapsed: boolean;
  currentVersion: string;
  onError: (error: unknown, fallback: string) => void;
  onRestarted?: (url: string) => void;
}

function reloadPage(url: string) {
  window.history.replaceState(window.history.state, '', url);
  window.location.reload();
}

export function UpdateControl({
  client,
  collapsed,
  currentVersion,
  onError,
  onRestarted = reloadPage,
}: UpdateControlProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<DaemonUpdateStatus | null>(null);
  const [restarting, setRestarting] = useState<{
    startedAt: number;
    version: string;
    url: string;
  } | null>(null);
  const restartRequested = useRef(false);
  const clientGeneration = useRef(0);
  const callbacks = useRef({ onError, onRestarted, t });
  callbacks.current = { onError, onRestarted, t };

  useEffect(() => {
    setStatus(null);
    setRestarting(null);
    restartRequested.current = false;
    return () => {
      clientGeneration.current += 1;
    };
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      let delay = restarting !== null ? 2000 : 60_000;
      let failure: unknown;
      try {
        let next = await client.daemonUpdateStatus();
        if (cancelled) return;
        if (restarting !== null) {
          if (
            next.currentVersion &&
            next.currentVersion !== restarting.version
          ) {
            callbacks.current.onRestarted(restarting.url);
            return;
          }
          if (next.state === 'error') {
            restartRequested.current = false;
            setRestarting(null);
            callbacks.current.onError(
              new Error(next.message),
              callbacks.current.t('update.failed'),
            );
            return;
          }
        } else if (next.state === 'available' && next.canInstall) {
          next = await client.prepareDaemonUpdate();
          if (cancelled) return;
        }
        setStatus(next);
        if (next.state === 'installing' || restarting !== null) delay = 2000;
      } catch (error) {
        failure = error;
      }
      if (cancelled) return;
      if (restarting !== null && Date.now() - restarting.startedAt >= 60_000) {
        restartRequested.current = false;
        setRestarting(null);
        callbacks.current.onError(
          failure ?? new Error(callbacks.current.t('update.failed')),
          callbacks.current.t('update.failed'),
        );
        return;
      }
      timer = setTimeout(() => void check(), delay);
    };
    void check();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, restarting]);

  const restart = async () => {
    if (restartRequested.current) return;
    restartRequested.current = true;
    const generation = clientGeneration.current;
    setRestarting({
      startedAt: Date.now(),
      version: status?.currentVersion || currentVersion,
      url: window.location.href,
    });
    try {
      await client.restartDaemonForUpdate();
    } catch (error) {
      if (generation !== clientGeneration.current) return;
      restartRequested.current = false;
      setRestarting(null);
      onError(error, t('update.failed'));
    }
  };

  if (status?.state !== 'ready' && restarting === null) return null;
  const label = t(restarting !== null ? 'update.restarting' : 'update.button');
  const Icon = restarting !== null ? LoaderCircleIcon : ArrowUpCircleIcon;
  return (
    <Button
      type="button"
      variant="secondary"
      className={collapsed ? 'size-8 p-0' : 'h-6 gap-1 px-2 text-xs'}
      title={
        restarting !== null
          ? label
          : t('update.readyTitle', { version: status?.latestVersion || '' })
      }
      aria-label={label}
      disabled={restarting !== null}
      data-web-shell-update
      onClick={() => void restart()}
    >
      <Icon
        size={14}
        strokeWidth={1.5}
        className={restarting !== null ? 'animate-spin' : undefined}
        aria-hidden="true"
      />
      {!collapsed && label}
    </Button>
  );
}
