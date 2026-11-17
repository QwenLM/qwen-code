import { useMemo, useState } from 'react';
import type {
  DaemonClient,
  DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { useSessionCatalogQuery } from '../../session-catalog/session-catalog-hooks';
import type { SessionCatalogQuery } from '../../session-catalog/session-catalog-store';
import { extractErrorDetail } from '../../utils/errorDetail';
import {
  disambiguateWorkspaceLabels,
  workspaceBasename,
  workspaceLabel,
} from '../../utils/workspace';
import { Button } from '../ui/button';
import { Field, FieldError, FieldGroup, FieldLabel } from '../ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Textarea } from '../ui/textarea';

const NEW_SESSION = '__new__';

/** The session the dialog sends from: the main chat or a split pane. */
export interface SendToSessionCaller {
  sessionId: string;
  workspaceCwd: string;
  clientId?: string;
}

export interface SendToSessionRequest {
  workspaceCwd: string;
  targetSessionId?: string;
  prompt: string;
}

export function SendToSessionDialog({
  client,
  callerSessionId,
  currentWorkspaceCwd,
  workspaces,
  onSend,
  onCancel,
  onBusyChange,
}: {
  client: DaemonClient;
  callerSessionId: string;
  currentWorkspaceCwd: string;
  /** Trusted workspaces the caller may send to, its own included. */
  workspaces: readonly DaemonWorkspaceCapability[];
  onSend: (request: SendToSessionRequest) => Promise<void>;
  onCancel: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useI18n();
  const [workspaceCwd, setWorkspaceCwd] = useState(currentWorkspaceCwd);
  const [target, setTarget] = useState(NEW_SESSION);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const labeledWorkspaces = useMemo(() => {
    const entries = workspaces.map((ws) => ({
      cwd: ws.cwd,
      label: workspaceLabel(ws),
    }));
    if (!entries.some((entry) => entry.cwd === currentWorkspaceCwd)) {
      entries.unshift({
        cwd: currentWorkspaceCwd,
        label: workspaceBasename(currentWorkspaceCwd),
      });
    }
    return disambiguateWorkspaceLabels(entries);
  }, [currentWorkspaceCwd, workspaces]);
  const sessionsQuery = useMemo<SessionCatalogQuery>(
    () => ({
      routeKind: 'qualified',
      workspaceCwd,
      options: { archiveState: 'active' },
    }),
    [workspaceCwd],
  );
  const sessionsResult = useSessionCatalogQuery(client, sessionsQuery, {
    autoLoad: true,
  });
  const sessions = sessionsResult.sessions.filter(
    (session) => session.sessionId !== callerSessionId,
  );

  const send = async () => {
    setBusy(true);
    onBusyChange?.(true);
    setError(undefined);
    try {
      await onSend({
        workspaceCwd,
        ...(target !== NEW_SESSION ? { targetSessionId: target } : {}),
        prompt: prompt.trim(),
      });
    } catch (sendError) {
      setError(extractErrorDetail(sendError));
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && prompt.trim()) void send();
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="send-to-session-workspace">
            {t('sendToSession.workspace')}
          </FieldLabel>
          <Select
            value={workspaceCwd}
            disabled={busy}
            onValueChange={(value) => {
              setWorkspaceCwd(value);
              setTarget(NEW_SESSION);
            }}
          >
            <SelectTrigger
              id="send-to-session-workspace"
              className="w-full"
              data-testid="send-to-session-workspace"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {labeledWorkspaces.map((ws) => (
                <SelectItem key={ws.cwd} value={ws.cwd}>
                  {ws.cwd === currentWorkspaceCwd
                    ? t('sendToSession.currentWorkspace', { name: ws.label })
                    : ws.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="send-to-session-target">
            {t('sendToSession.target')}
          </FieldLabel>
          <Select value={target} disabled={busy} onValueChange={setTarget}>
            <SelectTrigger
              id="send-to-session-target"
              className="w-full"
              data-testid="send-to-session-target"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NEW_SESSION}>
                {t('sendToSession.newSession')}
              </SelectItem>
              {sessions.map((session) => (
                <SelectItem key={session.sessionId} value={session.sessionId}>
                  {session.displayName?.trim() || session.sessionId.slice(0, 8)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="send-to-session-message">
            {t('sendToSession.message')}
          </FieldLabel>
          <Textarea
            id="send-to-session-message"
            data-testid="send-to-session-message"
            rows={5}
            value={prompt}
            disabled={busy}
            placeholder={t('sendToSession.messagePlaceholder')}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </Field>
        {error && <FieldError>{error}</FieldError>}
      </FieldGroup>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={onCancel}
        >
          {t('sendToSession.cancel')}
        </Button>
        <Button
          type="submit"
          disabled={busy || !prompt.trim()}
          data-testid="send-to-session-send"
        >
          {t(busy ? 'sendToSession.sending' : 'sendToSession.send')}
        </Button>
      </div>
    </form>
  );
}
