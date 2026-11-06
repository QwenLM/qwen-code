import { useCallback, useEffect, useRef, useState } from 'react';
import { bytesToHex } from '@noble/hashes/utils';
import { useI18n } from '../../i18n';
import { Alert, AlertDescription } from '../ui/alert';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import type { ManagedAgentProvider } from './managed-agent-provider';
import type {
  ManagedExtensionPin,
  ManagedMcpAuthBinding,
} from './managed-extension-types';
import { isManagedMcpAuthBindings } from './managed-extension-types';
import type {
  ManagedMcpOAuthAttempt,
  ManagedMcpOAuthServer,
  ManagedMcpOAuthSnapshot,
} from './managed-mcp-oauth-types';
import {
  getManagedClientId,
  managedRequestId,
} from './managed-session-storage';

export interface ManagedMcpOAuthPanelProps {
  provider: ManagedAgentProvider;
  sessionId: string;
  extensions?: ManagedExtensionPin[];
  onAuthorized: (binding: ManagedMcpAuthBinding) => void;
  onRevoked?: () => void;
}

export function ManagedMcpOAuthPanel({
  provider,
  sessionId,
  extensions,
  onAuthorized,
  onRevoked,
}: ManagedMcpOAuthPanelProps) {
  const { t } = useI18n();
  const api = provider.mcpOAuth;
  const clientId = getManagedClientId(provider.storageKey);
  const [snapshot, setSnapshot] = useState<ManagedMcpOAuthSnapshot>();
  const [attempt, setAttempt] = useState<ManagedMcpOAuthAttempt>();
  const attemptId = attempt?.attemptId;
  const attemptState = attempt?.state;
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const flow = useRef<
    | {
        server: ManagedMcpOAuthServer;
        nonce: string;
        key: string;
        completed: boolean;
        notified: boolean;
      }
    | undefined
  >(undefined);
  const popup = useRef<Window | null>(null);
  const callback = useRef(onAuthorized);
  callback.current = onAuthorized;
  const revoked = useRef(onRevoked);
  revoked.current = onRevoked;
  const scope = JSON.stringify(extensions ?? null);
  const request = useRef<AbortController | undefined>(undefined);
  const load = useCallback(
    async (signal: AbortSignal) => {
      if (!api) return;
      const result = await api.query(
        sessionId,
        scope === 'null'
          ? undefined
          : (JSON.parse(scope) as ManagedExtensionPin[]),
        { clientId, signal },
      );
      if (!Array.isArray(result.servers))
        throw new Error('Invalid MCP authorization status.');
      if (!signal.aborted) setSnapshot(result);
    },
    [api, sessionId, scope, clientId],
  );

  useEffect(() => {
    const abort = new AbortController();
    request.current?.abort();
    request.current = abort;
    flow.current = undefined;
    setAttempt(undefined);
    setSnapshot(undefined);
    setFailed(false);
    void load(abort.signal).catch(() => {
      if (!abort.signal.aborted) setFailed(true);
    });
    return () => {
      abort.abort();
      request.current?.abort();
      popup.current?.close();
    };
  }, [load]);

  const accept = useCallback((result: ManagedMcpOAuthAttempt) => {
    if (result.authorizationUrl) {
      const url = new URL(result.authorizationUrl);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error('Invalid authorization URL.');
    }
    setAttempt(result);
    const current = flow.current;
    if (result.state === 'completed' && current && !current.notified) {
      const binding = {
        serverId: current.server.serverId,
        credentialId: result.credentialId,
        credentialGeneration: result.generation,
      };
      if (!isManagedMcpAuthBindings([binding]))
        throw new Error('Invalid authorization result.');
      current.notified = true;
      popup.current?.close();
      callback.current(binding as ManagedMcpAuthBinding);
    }
  }, []);

  useEffect(() => {
    if (
      !api ||
      !attemptId ||
      !attemptState ||
      ['completed', 'failed', 'expired'].includes(attemptState)
    )
      return;
    const abort = new AbortController();
    const expectedFlow = flow.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = await api.status(sessionId, attemptId, {
          clientId,
          signal: abort.signal,
        });
        if (abort.signal.aborted || flow.current !== expectedFlow) return;
        const current = flow.current;
        if (result.state === 'code_received' && current && !current.completed) {
          current.completed = true;
          const completed = await api.complete(
            sessionId,
            { attemptId: result.attemptId, browserNonce: current.nonce },
            { clientId, signal: abort.signal },
          );
          if (!abort.signal.aborted) accept(completed);
        } else accept(result);
        if (
          !abort.signal.aborted &&
          !['completed', 'failed', 'expired'].includes(result.state)
        )
          timer = setTimeout(() => void poll(), 1500);
      } catch {
        if (!abort.signal.aborted) setFailed(true);
      }
    };
    timer = setTimeout(() => void poll(), 1500);
    return () => {
      abort.abort();
      if (timer) clearTimeout(timer);
    };
  }, [api, sessionId, attemptId, attemptState, clientId, accept]);

  const start = async (server: ManagedMcpOAuthServer) => {
    if (!api || busy || snapshot?.supported !== true || !snapshot.canAuthorize)
      return;
    const abort = new AbortController();
    request.current?.abort();
    request.current = abort;
    setBusy(true);
    setFailed(false);
    try {
      const current =
        flow.current?.server.serverId === server.serverId && !attempt
          ? flow.current
          : {
              server,
              nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
              key: managedRequestId(),
              completed: false,
              notified: false,
            };
      flow.current = current;
      setAttempt(undefined);
      popup.current?.close();
      popup.current = window.open('about:blank', '_blank');
      if (popup.current) popup.current.opener = null;
      const result = await api.start(
        sessionId,
        {
          serverId: server.serverId,
          pin: server.pin,
          browserNonce: current.nonce,
        },
        { clientId, signal: abort.signal, idempotencyKey: current.key },
      );
      if (abort.signal.aborted) return;
      if (!result.authorizationUrl)
        throw new Error('Missing authorization URL.');
      const url = new URL(result.authorizationUrl);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error('Invalid authorization URL.');
      if (popup.current) popup.current.location.replace(url.href);
      accept({ ...result, state: 'pending' });
    } catch {
      if (!abort.signal.aborted) {
        setFailed(true);
        popup.current?.close();
      }
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  };

  if (!api) return null;
  return (
    <div className="grid gap-3" data-managed-mcp-oauth>
      <p className="text-sm text-muted-foreground">
        {t('managed.oauth.notice')}
      </p>
      {snapshot?.supported === false && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('managed.oauth.credential.unavailable')}
        </p>
      )}
      {failed && (
        <Alert variant="destructive">
          <AlertDescription>{t('managed.oauth.failed')}</AlertDescription>
        </Alert>
      )}
      {attempt && (
        <div className="flex flex-wrap items-center gap-2" role="status">
          <Badge variant="secondary">
            {t(`managed.oauth.state.${attempt.state}`)}
          </Badge>
          {attempt.authorizationUrl && attempt.state === 'pending' && (
            <a
              href={attempt.authorizationUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm underline"
            >
              {t('managed.oauth.open')}
            </a>
          )}
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              const abort = new AbortController();
              request.current?.abort();
              request.current = abort;
              setBusy(true);
              void api
                .status(sessionId, attempt.attemptId, {
                  clientId,
                  signal: abort.signal,
                })
                .then(async (result) => {
                  if (abort.signal.aborted) return;
                  if (result.state === 'code_received' && flow.current) {
                    flow.current.completed = true;
                    result = await api.complete(
                      sessionId,
                      {
                        attemptId: result.attemptId,
                        browserNonce: flow.current.nonce,
                      },
                      { clientId, signal: abort.signal },
                    );
                  }
                  if (!abort.signal.aborted) {
                    accept(result);
                    setFailed(false);
                  }
                })
                .catch(() => {
                  if (!abort.signal.aborted) setFailed(true);
                })
                .finally(() => {
                  if (!abort.signal.aborted) setBusy(false);
                });
            }}
          >
            {t('managed.oauth.check')}
          </Button>
        </div>
      )}
      {snapshot?.servers.map((server) => (
        <div
          key={server.serverId}
          className="grid gap-2 rounded-md border p-3 text-sm"
        >
          <strong>{server.serverName}</strong>
          <p>
            {server.providerId} · {server.resourceUri}
          </p>
          <p>{server.scopes.join(', ')}</p>
          <Badge variant="outline">
            {t(`managed.oauth.credential.${server.state}`)}
          </Badge>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={
                busy || snapshot.supported !== true || !snapshot.canAuthorize
              }
              onClick={() => void start(server)}
            >
              {t('managed.oauth.authorize')}
            </Button>
            {server.actorOwned && server.credentialId && server.generation && (
              <>
                {server.state === 'authorized' && (
                  <Button
                    variant="outline"
                    disabled={
                      busy ||
                      snapshot.supported !== true ||
                      !snapshot.canAuthorize
                    }
                    onClick={() =>
                      callback.current({
                        serverId: server.serverId,
                        credentialId: server.credentialId!,
                        credentialGeneration: server.generation!,
                      })
                    }
                  >
                    {t('managed.oauth.bind')}
                  </Button>
                )}
                {server.state !== 'revoked' && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      const abort = new AbortController();
                      request.current?.abort();
                      request.current = abort;
                      flow.current = undefined;
                      setAttempt(undefined);
                      popup.current?.close();
                      setBusy(true);
                      setFailed(false);
                      void api
                        .revoke(
                          sessionId,
                          {
                            credentialId: server.credentialId!,
                            expectedGeneration: server.generation!,
                          },
                          { clientId, signal: abort.signal },
                        )
                        .then(async () => {
                          if (abort.signal.aborted) return;
                          await load(abort.signal);
                          if (!abort.signal.aborted) revoked.current?.();
                        })
                        .catch(() => {
                          if (!abort.signal.aborted) setFailed(true);
                        })
                        .finally(() => {
                          if (!abort.signal.aborted) setBusy(false);
                        });
                    }}
                  >
                    {t('managed.oauth.revoke')}
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
