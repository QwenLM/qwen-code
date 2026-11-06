import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useConnection,
  useDaemonSessionOwnerGuard,
  useWorkspaceActions,
  useActions,
} from '@qwen-code/web-shell/daemon-react-sdk';
import type { useI18n } from '../i18n';
import { isDesktopShell, openExternalUrl } from '../utils/externalOpen';

interface Options {
  t: ReturnType<typeof useI18n>['t'];
  workspaceCwd?: string;
  isBlocked: () => boolean;
  onBlocked: () => boolean;
  onNotice: (kind: 'info' | 'success' | 'warning', message: string) => void;
  onError: (error: unknown, message: string) => void;
  onCommand?: (text: string) => boolean;
}

export function useSubscriptionLogout(options: Options) {
  const connection = useConnection();
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const actions = useWorkspaceActions();
  const sessionActions = useActions();
  const ownerGuard = useDaemonSessionOwnerGuard();
  const callbacks = useRef(options);
  callbacks.current = options;
  const pending = useRef(false);
  const [available, setAvailable] = useState(false);
  const { workspaceCwd, t } = options;
  const sessionAuthType = connection.sessionId
    ? connection.context?.state._meta?.['authType']
    : undefined;
  const canCheckAvailability =
    !connection.sessionId || connection.status === 'connected';
  const loadAuthType = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (connectionRef.current.sessionId) {
        const context = await sessionActions.getContext(opts);
        return context.state._meta?.['authType'];
      }
      if (!workspaceCwd) return undefined;
      return (await actions.loadProviders(workspaceCwd)).current?.authType;
    },
    [actions, sessionActions, workspaceCwd],
  );

  useEffect(() => {
    const abort = new AbortController();
    const owner = ownerGuard.capture();
    setAvailable(false);
    if (workspaceCwd && connection.providers && canCheckAvailability) {
      void actions
        .getSubscriptionConfig({ signal: abort.signal })
        .then(async (config) => {
          if (
            abort.signal.aborted ||
            !owner.isCurrent() ||
            !config.enabled ||
            !config.signedIn
          )
            return;
          const authType = await loadAuthType({ silent: true });
          const latest = await actions.getSubscriptionConfig({
            signal: abort.signal,
          });
          if (!abort.signal.aborted && owner.isCurrent())
            setAvailable(
              latest.enabled &&
                latest.signedIn === true &&
                authType === 'qwen-subscription',
            );
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
    canCheckAvailability,
    sessionAuthType,
    loadAuthType,
  ]);

  const handleCommand = useCallback(
    (text: string): boolean | undefined => {
      const command = /^\/(logout|upgrade)(?:\s|$)/i
        .exec(text.trim())?.[1]
        ?.toLowerCase();
      if (
        !command ||
        connection.commands?.some(
          (entry) =>
            entry.name === command &&
            entry.source &&
            entry.source !== 'builtin-command',
        )
      )
        return undefined;
      if (!workspaceCwd) return false;
      if (callbacks.current.isBlocked()) return callbacks.current.onBlocked();
      if (pending.current) return true;
      const owner = ownerGuard.capture();
      const model = connectionRef.current.currentModel;
      const authType = connectionRef.current.context?.state._meta?.['authType'];
      const isCurrent = () =>
        owner.isCurrent() &&
        connectionRef.current.currentModel === model &&
        connectionRef.current.context?.state._meta?.['authType'] === authType;
      pending.current = true;
      void actions
        .getSubscriptionConfig()
        .then(async (config) => {
          if (!isCurrent()) return;
          if (!config.enabled) {
            callbacks.current.onNotice('info', t('subscription.unavailable'));
            return;
          }
          const authType = await loadAuthType();
          if (!isCurrent()) return;
          const latest = await actions.getSubscriptionConfig();
          if (!isCurrent()) return;
          if (
            !latest.enabled ||
            !latest.signedIn ||
            authType !== 'qwen-subscription'
          ) {
            setAvailable(false);
            callbacks.current.onNotice(
              'info',
              t(
                command === 'logout'
                  ? 'subscription.logoutNotRequired'
                  : 'subscription.commandUnavailable',
              ),
            );
            return;
          }
          if (callbacks.current.isBlocked()) {
            callbacks.current.onBlocked();
            return;
          }
          if (callbacks.current.onCommand?.(text)) return;
          if (command === 'upgrade') {
            if (latest.plansUrl) {
              if (isDesktopShell()) await openExternalUrl(latest.plansUrl);
              else
                window.open(latest.plansUrl, '_blank', 'noopener,noreferrer');
            }
            return;
          }
          await actions.signOutSubscription();
          setAvailable(false);
          if (!owner.isCurrent()) return;
          await sessionActions.refreshModels(undefined, {
            reloadProviders: false,
          });
          if (owner.isCurrent()) setAvailable(false);
        })
        .catch((error: unknown) => {
          if (!owner.isCurrent()) return;
          const failure = error as { body?: { errorStage?: string } };
          if (failure?.body?.errorStage === 'revoke') {
            setAvailable(false);
            void sessionActions
              .refreshModels(undefined, { reloadProviders: false })
              .catch((refreshError: unknown) => {
                if (owner.isCurrent())
                  callbacks.current.onError(
                    refreshError,
                    t('subscription.signOutFailed'),
                  );
              });
            callbacks.current.onNotice(
              'warning',
              t('subscription.signedOutLocally'),
            );
          } else {
            callbacks.current.onError(
              error,
              t(
                command === 'logout'
                  ? 'subscription.signOutFailed'
                  : 'subscription.upgradeFailed',
              ),
            );
          }
        })
        .finally(() => {
          pending.current = false;
        });
      return true;
    },
    [
      actions,
      sessionActions,
      connection.commands,
      ownerGuard,
      t,
      workspaceCwd,
      loadAuthType,
    ],
  );

  return { available, handleCommand };
}
