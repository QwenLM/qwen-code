import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useConnection,
  useDaemonSessionOwnerGuard,
  useWorkspaceActions,
} from '@qwen-code/web-shell/daemon-react-sdk';
import type { useI18n } from '../i18n';

interface Options {
  t: ReturnType<typeof useI18n>['t'];
  workspaceCwd?: string;
  isBlocked: () => boolean;
  onBlocked: () => boolean;
  onNotice: (kind: 'info' | 'success' | 'warning', message: string) => void;
  onError: (error: unknown, message: string) => void;
}

export function useSubscriptionLogout(options: Options) {
  const connection = useConnection();
  const actions = useWorkspaceActions();
  const ownerGuard = useDaemonSessionOwnerGuard();
  const callbacks = useRef(options);
  callbacks.current = options;
  const pending = useRef(false);
  const [available, setAvailable] = useState(false);
  const { workspaceCwd, t } = options;

  useEffect(() => {
    const abort = new AbortController();
    const owner = ownerGuard.capture();
    setAvailable(false);
    if (workspaceCwd && connection.providers) {
      void actions
        .getSubscriptionConfig({ signal: abort.signal })
        .then(async (config) => {
          if (abort.signal.aborted || !owner.isCurrent() || !config.enabled)
            return;
          const providers = await actions.loadProviders(workspaceCwd);
          if (!abort.signal.aborted && owner.isCurrent())
            setAvailable(providers.current?.authType === 'qwen-subscription');
        })
        .catch(() => undefined);
    }
    return () => abort.abort();
  }, [
    actions,
    ownerGuard,
    workspaceCwd,
    connection.sessionId,
    connection.currentModel,
    connection.providers,
  ]);

  const handleCommand = useCallback(
    (text: string): boolean | undefined => {
      if (
        !/^\/logout(?:\s|$)/.test(text.trim()) ||
        connection.commands?.some(
          (command) =>
            command.name === 'logout' &&
            command.source &&
            command.source !== 'builtin-command',
        )
      )
        return undefined;
      if (!workspaceCwd) return false;
      if (callbacks.current.isBlocked()) return callbacks.current.onBlocked();
      if (pending.current) return true;
      const owner = ownerGuard.capture();
      pending.current = true;
      void actions
        .getSubscriptionConfig()
        .then(async (config) => {
          if (!owner.isCurrent()) return;
          if (!config.enabled) {
            callbacks.current.onNotice('info', t('subscription.unavailable'));
            return;
          }
          const providers = await actions.loadProviders(workspaceCwd);
          if (!owner.isCurrent()) return;
          if (providers.current?.authType !== 'qwen-subscription') {
            callbacks.current.onNotice(
              'info',
              t('subscription.logoutNotRequired'),
            );
            return;
          }
          if (callbacks.current.isBlocked()) {
            callbacks.current.onBlocked();
            return;
          }
          await actions.signOutSubscription();
          if (!owner.isCurrent()) return;
          callbacks.current.onNotice('success', t('subscription.signedOut'));
        })
        .catch((error: unknown) => {
          if (!owner.isCurrent()) return;
          const failure = error as { body?: { errorStage?: string } };
          if (failure?.body?.errorStage === 'revoke') {
            callbacks.current.onNotice(
              'warning',
              t('subscription.signedOutLocally'),
            );
          } else {
            callbacks.current.onError(error, t('subscription.signOutFailed'));
          }
        })
        .finally(() => {
          pending.current = false;
        });
      return true;
    },
    [actions, connection.commands, ownerGuard, t, workspaceCwd],
  );

  return { available, handleCommand };
}
